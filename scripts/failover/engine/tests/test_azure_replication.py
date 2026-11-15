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
        self.calls, self.cname, self.settings, self.state = [], None, {}, 'Ready'
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
                return self._json({})
            if self.cname is None:
                raise urllib.error.HTTPError(url, 404, 'not found', {}, io.BytesIO(b''))
            return self._json({'properties': {'cnameRecord': {'cname': self.cname}}})
        if 'vault.azure.net' in url:
            assert req.headers['Authorization'] == 'Bearer token-https%3A%2F%2Fvault.azure.net'
            return self._json({'value': 's3cret'})
        if '/configurations/' in path:
            name = path.rsplit('/', 1)[1]
            if method == 'PUT':
                self.settings[name] = body['properties']['value']
                return self._json({})
            return self._json({'properties': {'value': self.settings.get(name, 'default'), 'isConfigPendingRestart': False}})
        if path.endswith('/restart'):
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

    def test_alias_read_write_with_short_ttl(self):
        pair = self.platform.pairs()[0]
        self.assertIsNone(self.platform.alias_get(pair))
        self.platform.alias_set(pair, 'it.example')
        self.assertEqual(self.platform.alias_get(pair), 'it.example')
        put = next(c for c in self.arm.calls if c[0] == 'PUT')
        self.assertTrue(put[1].endswith('/privateDnsZones/cnp-sov.postgres.database.azure.com/CNAME/todo-prod-db'))
        self.assertEqual(put[2]['properties']['ttl'], 30)

    def test_password_from_vault_with_vault_token(self):
        self.assertEqual(self.platform.password(self.platform.pairs()[0]), 's3cret')
        self.assertTrue(any('/secrets/todo-prod-pg-password' in c[1] for c in self.arm.calls))

    def test_settings_applied_then_restart_then_nothing(self):
        pair = self.platform.pairs()[0]
        self.assertEqual(self.platform.ensure_settings(pair.copy, ar.REQUIRED_SETTINGS), ['wal_level', 'max_worker_processes', 'restart'])
        self.assertTrue(any(c[0] == 'POST' and c[1].endswith('cnp-sov-it-todo-prod/restart') and '/rg-it/' in c[1] for c in self.arm.calls))
        self.assertEqual(self.platform.ensure_settings(pair.copy, ar.REQUIRED_SETTINGS), [])

    def test_no_change_while_server_is_not_ready(self):
        self.arm.state = 'Restarting'
        self.assertEqual(self.platform.ensure_settings(self.platform.pairs()[0].primary, ar.REQUIRED_SETTINGS), ['server-Restarting'])
        self.assertFalse(any(c[0] in ('PUT', 'POST') for c in self.arm.calls))


class FakePlatform:
    def __init__(self, alias=None):
        self.pair = ar.Pair('todo', 'prod', ar.Server('fr', 'a', 'fr.example', 'pgadmin'), ar.Server('it', 'b', 'it.example', 'pgadmin'))
        self.alias, self.writes = alias, []

    def pairs(self):
        return [self.pair]

    def alias_get(self, pair):
        return self.alias

    def alias_set(self, pair, fqdn):
        self.alias = fqdn
        self.writes.append(fqdn)

    def password(self, pair):
        return 'pw'

    def ensure_settings(self, server, settings):
        return []


class EngineDecisionTest(unittest.TestCase):
    def engine(self, platform, reachable=()):
        def connect(server, password):
            if server.key not in reachable:
                raise OSError('injoignable')
            raise AssertionError('connexion non prévue dans ce test')
        return ar.Engine(platform, connect=connect, log=lambda line: None, sleep=lambda s: None)

    def test_status_never_creates_the_alias(self):
        platform = FakePlatform()
        self.assertEqual(self.engine(platform).reconcile(apply=False)[0]['state'], 'NO_ALIAS')
        self.assertEqual(platform.writes, [])

    def test_reconcile_creates_alias_towards_primary_and_reports_unreachable_active(self):
        platform = FakePlatform()
        self.assertEqual(self.engine(platform).reconcile()[0]['state'], 'ACTIVE_UNREACHABLE')
        self.assertEqual(platform.writes, ['fr.example'])

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


if __name__ == '__main__':
    unittest.main()
