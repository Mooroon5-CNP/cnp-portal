"""Moteur Azure (azure_replication.py) : couche Azure contre un faux ARM, décisions de l'orchestrateur sans base.

Le scénario PostgreSQL réel (réplication, bascules, panne, migration) est dans run_docker_azure_replication.py.
"""
import io
import json
from pathlib import Path
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import azure_replication as ar

ENV = {
    'AZURE_SUBSCRIPTION_ID': 'sub', 'PRIMARY_RESOURCE_GROUP': 'rg-fr', 'COPY_RESOURCE_GROUP': 'rg-it',
    'DNS_ZONE_RESOURCE_GROUP': 'rg-shared', 'DNS_ZONE': 'cnp-sov.postgres.database.azure.com', 'VAULT_NAME': 'kv',
    'UAMI_CLIENT_ID': 'client', 'IDENTITY_ENDPOINT': 'http://identity', 'IDENTITY_HEADER': 'h',
}


def server(name, fqdn, role, app='todo', env='prod'):
    return {'name': name, 'tags': {'cnp-role': role, 'cnp-app': app, 'cnp-env': env},
            'properties': {'fullyQualifiedDomainName': fqdn, 'administratorLogin': 'pgadmin'}}


class FakeArm:
    """Répond comme ARM / Key Vault / l'endpoint d'identité ; garde trace des écritures."""

    def __init__(self):
        self.calls, self.cname, self.meta, self.settings, self.state, self.pending = [], None, {}, {}, 'Ready', False
        self.servers = {
            'rg-fr': [server('cnp-sov-fr-todo-prod', 'fr.example', 'app-db'), server('cnp-sov-fr-todo-dev', 'dev.example', 'app-db', env='dev'),
                      server('cnp-sov-fr-solo-prod', 'solo.example', 'app-db', app='solo')],
            'rg-it': [server('cnp-sov-it-todo-prod', 'it.example', 'copy-db')],
        }

    def __call__(self, req, timeout=None):
        url, method = req.full_url, req.get_method()
        body = json.loads(req.data) if req.data else None
        self.calls.append((method, url.split('?')[0], body))
        path = url.split('?')[0]
        if url.startswith('http://identity'):
            assert req.headers.get('X-identity-header') == 'h'
            return self._json({'access_token': 'token-' + url.split('resource=')[1].split('&')[0]})
        assert req.headers['Authorization'].startswith('Bearer token-')
        if path.endswith('/flexibleServers'):
            rg = path.split('/resourceGroups/')[1].split('/')[0]
            return self._json({'value': self.servers[rg]})
        if '/CNAME/' in path:
            if method == 'PUT':
                self.cname = body['properties']['cnameRecord']['cname']
                self.meta = body['properties']['metadata']
                return self._json({})
            if self.cname is None:
                raise urllib.error.HTTPError(url, 404, 'not found', {}, io.BytesIO(b''))
            return self._json({'properties': {'cnameRecord': {'cname': self.cname}, 'metadata': self.meta}})
        if 'vault.azure.net' in url:
            assert req.headers['Authorization'] == 'Bearer token-https%3A%2F%2Fvault.azure.net'
            return self._json({'value': 's3cret'})
        if '/configurations/' in path:
            name = path.rsplit('/', 1)[1]
            if method == 'PUT':
                self.settings[name] = body['properties']['value']
                self.pending = True
                return self._json({})
            return self._json({'properties': {'value': self.settings.get(name, 'default'), 'isConfigPendingRestart': self.pending}})
        if path.endswith('/restart'):
            self.pending = False
            return self._json({})
        if '/flexibleServers/' in path:
            return self._json({'properties': {'state': self.state}})
        raise AssertionError(f'appel inattendu {method} {url}')

    @staticmethod
    def _json(value):
        return io.BytesIO(json.dumps(value).encode())


class AzurePlatformTest(unittest.TestCase):
    def setUp(self):
        self.arm = FakeArm()
        self.platform = ar.AzurePlatform(ENV, opener=self.arm)

    def test_pairs_by_tags_prod_only_and_only_with_a_copy(self):
        pairs = self.platform.pairs()
        self.assertEqual([(p.app, p.env, p.primary.fqdn, p.copy.fqdn, p.primary.key, p.copy.key) for p in pairs],
                         [('todo', 'prod', 'fr.example', 'it.example', 'fr', 'it')])
        self.assertEqual(pairs[0].alias, 'todo-prod-db')

    def test_primary_servers_in_their_own_resource_group_when_configured(self):
        # Base principale en Italie (PRIMARY_DB_RESOURCE_GROUP), Container Apps en France : les serveurs app-db sont lus là.
        self.arm.servers['rg-it'].append(server('cnp-sov-itdb-solo-dev', 'itdb.example', 'app-db', app='solo', env='dev'))
        platform = ar.AzurePlatform({**ENV, 'PRIMARY_DB_RESOURCE_GROUP': 'rg-it', 'PRIMARY_KEY': 'itdb'}, opener=self.arm)
        found = platform.app_servers()
        self.assertIn(('solo', 'dev', 'cnp-sov-itdb-solo-dev'), [(a, e, s.name) for a, e, s in found])
        self.assertNotIn('cnp-sov-fr-todo-prod', [s.name for _, _, s in found])
        self.assertEqual(platform.server_state(next(s for _, _, s in found if s.name == 'cnp-sov-itdb-solo-dev')), 'Ready')
        self.assertTrue(any('/resourceGroups/rg-it/providers/Microsoft.DBforPostgreSQL/flexibleServers/cnp-sov-itdb-solo-dev' in c[1]
                            for c in self.arm.calls))

    def test_servers_being_deleted_are_left_out_but_stopped_ones_stay(self):
        dropping = server('cnp-sov-it-todo-prod', 'it.example', 'copy-db')
        dropping['properties'] = {'state': 'Dropping'}
        self.arm.servers['rg-it'] = [dropping]
        self.assertEqual(self.platform.pairs(), [])
        stopped = server('cnp-sov-it-todo-prod', 'it.example', 'copy-db')
        stopped['properties']['state'] = 'Stopped'
        self.arm.servers['rg-it'] = [stopped]
        self.assertEqual(len(self.platform.pairs()), 1)

    def test_alias_read_write_with_short_ttl_and_memory(self):
        pair = self.platform.pairs()[0]
        self.assertIsNone(self.platform.alias_get(pair))
        self.platform.alias_set(pair, 'it.example', {'reason': 'failover-auto'})
        self.assertEqual(self.platform.alias_get(pair), 'it.example')
        self.assertEqual(self.platform.alias_meta(pair), {'reason': 'failover-auto'})
        self.assertEqual(self.arm.meta['cnp_app'], 'todo')
        self.platform.alias_set(pair, 'fr.example')  # None : la mémoire est conservée
        self.assertEqual(self.platform.alias_meta(pair), {'reason': 'failover-auto'})
        put = next(c for c in self.arm.calls if c[0] == 'PUT')
        self.assertTrue(put[1].endswith('/privateDnsZones/cnp-sov.postgres.database.azure.com/CNAME/todo-prod-db'))
        self.assertEqual(put[2]['properties']['ttl'], 30)

    def test_password_from_vault_with_vault_token(self):
        self.assertEqual(self.platform.password(self.platform.pairs()[0]), 's3cret')
        self.assertTrue(any('/secrets/todo-prod-pg-password' in c[1] for c in self.arm.calls))

    def test_settings_written_then_one_restart_on_a_later_run_then_nothing(self):
        # Azure applique les réglages de façon asynchrone : écriture d'abord, un seul redémarrage à l'exécution suivante.
        pair = self.platform.pairs()[0]
        self.assertEqual(self.platform.ensure_settings(pair.copy, ar.REQUIRED_SETTINGS), ['wal_level', 'max_worker_processes'])
        self.assertFalse(any(c[0] == 'POST' for c in self.arm.calls))
        self.assertEqual(self.platform.ensure_settings(pair.copy, ar.REQUIRED_SETTINGS), ['restart'])
        self.assertEqual(sum(1 for c in self.arm.calls if c[0] == 'POST' and c[1].endswith('cnp-sov-it-todo-prod/restart') and '/rg-it/' in c[1]), 1)
        self.assertEqual(self.platform.ensure_settings(pair.copy, ar.REQUIRED_SETTINGS), [])

    def test_server_state_and_unknown_when_azure_fails(self):
        pair = self.platform.pairs()[0]
        self.assertEqual(self.platform.server_state(pair.primary), 'Ready')
        broken = ar.AzurePlatform(ENV, opener=lambda req, timeout=None: (_ for _ in ()).throw(OSError('région injoignable')))
        self.assertEqual(broken.server_state(pair.primary), 'unknown')


class FakePlatform:
    def __init__(self, alias=None):
        self.pair = ar.Pair('todo', 'prod', ar.Server('fr', 'a', 'fr.example', 'pgadmin'), ar.Server('it', 'b', 'it.example', 'pgadmin'))
        self.alias, self.writes, self.meta, self.state = alias, [], {}, 'Ready'

    def pairs(self):
        return [self.pair]

    def alias_get(self, pair):
        return self.alias

    def alias_set(self, pair, fqdn, meta=None):
        self.alias = fqdn
        if meta is not None:
            self.meta = dict(meta)
        self.writes.append(fqdn)

    def alias_meta(self, pair):
        return self.meta

    def password(self, pair):
        return 'pw'

    def server_state(self, server):
        return self.state

    def ensure_settings(self, server, settings):
        return []


class EngineDecisionTest(unittest.TestCase):
    def engine(self, platform, reachable=()):
        def connect(server, password, dbname='appdb'):
            if server.key not in reachable:
                raise OSError('injoignable')
            raise AssertionError('connexion non prévue dans ce test')
        return ar.Engine(platform, connect=connect, log=lambda line: None, sleep=lambda s: None)

    def test_status_never_creates_the_alias(self):
        platform = FakePlatform()
        self.assertEqual(self.engine(platform).reconcile(apply=False)[0]['state'], 'NO_ALIAS')
        self.assertEqual(platform.writes, [])

    def test_reconcile_creates_alias_towards_primary_and_remembers_unreachable_active(self):
        platform = FakePlatform()
        self.assertEqual(self.engine(platform).reconcile()[0]['state'], 'ACTIVE_UNREACHABLE')
        self.assertEqual(platform.writes[0], 'fr.example')
        self.assertIn('unreachable_since', platform.meta)

    def test_restarting_active_is_not_reported_as_unreachable(self):
        platform = FakePlatform(alias='fr.example')
        platform.state = 'Restarting'
        self.assertEqual(self.engine(platform).reconcile()[0]['state'], 'ACTIVE_RESTARTING')

    def test_alias_on_an_unknown_server_is_an_error_not_a_guess(self):
        result = self.engine(FakePlatform(alias='autre.example')).reconcile()[0]
        self.assertEqual(result['state'], 'ERROR')
        self.assertIn('aucun des deux serveurs', result['detail'])

    def test_switch_refused_when_a_server_is_down(self):
        platform = FakePlatform(alias='fr.example')
        with self.assertRaisesRegex(RuntimeError, 'failover'):
            self.engine(platform).switch(platform.pair)
        self.assertEqual(platform.writes, [])

    def test_failover_refused_when_standby_is_also_down(self):
        platform = FakePlatform(alias='fr.example')
        with self.assertRaisesRegex(RuntimeError, 'aucune bascule'):
            self.engine(platform).failover(platform.pair, attempts=1)
        self.assertEqual(platform.writes, [])

    def test_subscription_password_is_escaped_in_conninfo(self):
        executed = []

        class Conn:
            def execute(self, query, *args):
                executed.append(query)

        ar.subscribe(Conn(), ar.Server('fr', 'a', 'fr.example', 'pgadmin'), "a'b\\c", 'cnp_azure_from_fr')
        literal = executed[0]._obj[3]._obj  # sql.Composed : CREATE SUBSCRIPTION …, nom, CONNECTION, conninfo
        self.assertIn("password='a\\'b\\\\c'", literal)


class AutoPolicyTest(unittest.TestCase):
    pair = FakePlatform().pair
    policy = ar.AutoPolicy(failover_after=90, freshness=600, failback_after=600, restart_grace=600)

    def test_disabled_unless_explicitly_enabled(self):
        self.assertIsNone(ar.AutoPolicy.from_environ({}))
        self.assertIsNone(ar.AutoPolicy.from_environ({'CNP_AUTO_FAILOVER': 'yes'}))
        self.assertEqual(ar.AutoPolicy.from_environ({'CNP_AUTO_FAILOVER': 'true', 'CNP_FAILOVER_AFTER_SECONDS': '30'}).failover_after, 30)

    def test_failover_only_after_the_delay_and_with_a_fresh_standby(self):
        down = {'state': 'ACTIVE_UNREACHABLE', 'active': 'fr'}
        self.assertEqual(self.policy.decide(self.pair, down, {'unreachable_since': '1000', 'last_replicating': '990'}, 1060), 'waiting-failover-30s')
        self.assertEqual(self.policy.decide(self.pair, down, {'unreachable_since': '1000', 'last_replicating': '990'}, 1090), 'failover')
        self.assertEqual(self.policy.decide(self.pair, down, {'unreachable_since': '1000', 'last_replicating': '100'}, 1090),
                         'failover-refused-stale-standby')
        self.assertEqual(self.policy.decide(self.pair, down, {'unreachable_since': '1000'}, 1090), 'failover-refused-stale-standby')

    def test_a_restart_gets_a_longer_grace(self):
        restarting = {'state': 'ACTIVE_RESTARTING', 'active': 'fr'}
        meta = {'unreachable_since': '1000', 'last_replicating': '999'}
        self.assertTrue(self.policy.decide(self.pair, restarting, meta, 1300).startswith('waiting-failover'))
        self.assertEqual(self.policy.decide(self.pair, restarting, meta, 1600), 'failover')

    def test_failback_only_after_an_automatic_failover_and_a_stable_replication(self):
        replicating = {'state': 'REPLICATING', 'active': 'it'}
        self.assertEqual(self.policy.decide(self.pair, replicating, {'reason': 'failover-auto', 'replicating_since': '1000'}, 1600), 'failback')
        self.assertIsNone(self.policy.decide(self.pair, replicating, {'reason': 'failover-auto', 'replicating_since': '1000'}, 1500))
        self.assertIsNone(self.policy.decide(self.pair, replicating, {'reason': 'manual', 'replicating_since': '0'}, 1600))
        self.assertIsNone(self.policy.decide(self.pair, {'state': 'REPLICATING', 'active': 'fr'}, {'reason': 'failover-auto', 'replicating_since': '0'}, 1600))


if __name__ == '__main__':
    unittest.main()
