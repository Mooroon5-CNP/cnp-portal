#!/usr/bin/env python3
"""Scénario complet du moteur Azure (azure_replication.py) sur deux PostgreSQL 16 locaux jetables.

« fr » et « it » jouent les deux serveurs d'une app ; l'alias DNS est simulé en mémoire. Aucun credential cloud.
Réseau, conteneurs et volumes créés ici sont supprimés dans finally.

Usage : python tests/run_docker_azure_replication.py
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ['CNP_AZURE_SSLMODE'] = 'disable'

import psycopg  # noqa: E402
import azure_replication as ar  # noqa: E402
import database  # noqa: E402

IMAGE = os.environ.get('CNP_LOCAL_PG16_IMAGE', 'postgres:16')
PASSWORD = "p'a:ss\\word-" + uuid4().hex  # caractères à échapper dans un conninfo, exprès


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


class FakePlatform:
    def __init__(self, pair):
        self.pair, self.alias, self.meta, self.settings_calls = pair, None, {}, 0

    def pairs(self):
        return [self.pair]

    def alias_get(self, pair):
        return self.alias

    def alias_set(self, pair, fqdn, meta=None):
        self.alias = fqdn
        if meta is not None:
            self.meta = dict(meta)

    def alias_meta(self, pair):
        return self.meta

    def server_state(self, server):
        return 'Ready'

    def password(self, pair):
        return PASSWORD

    def ensure_settings(self, server, settings):
        self.settings_calls += 1
        return []

    def app_servers(self):
        return [(self.pair.app, self.pair.env, s) for s in self.pair.servers()]

    def vault_secret(self, name, required=True):
        return PASSWORD

    def runtime_password(self, app, env):
        return RUNTIME_PASSWORD


RUNTIME_PASSWORD = 'rUntime-' + uuid4().hex


def main():
    token = 'cnp-azrepl-' + uuid4().hex[:10]
    containers, network = [], None
    ports = {}
    try:
        network = docker('network', 'create', '--label', 'cnp.local-test=true', token)
        for key in ('fr', 'it'):
            cid = docker('run', '--rm', '--detach', '--name', f'{token}-{key}', '--label', 'cnp.local-test=true',
                         '--network', token, '--network-alias', key, '--publish', '127.0.0.1::5432',
                         '--env', 'POSTGRES_USER=pgadmin', '--env', f'POSTGRES_PASSWORD={PASSWORD}',
                         # Comme sur Azure : la base de l'app n'existe que sur le serveur de l'app ; le moteur la crée sur l'autre.
                         '--env', 'POSTGRES_DB=' + ('appdb' if key == 'fr' else 'postgres'),
                         IMAGE, 'postgres', '-c', 'wal_level=logical', '-c', 'max_worker_processes=16')
            containers.append(cid)
            ports[key] = json.loads(docker('inspect', cid))[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort']
        pair = ar.Pair('todo', 'prod', ar.Server('fr', 'fr', 'fr', 'pgadmin'), ar.Server('it', 'it', 'it', 'pgadmin'))

        def connect(server, password, dbname='appdb'):
            return psycopg.connect(host='127.0.0.1', port=ports[server.key], dbname=dbname, user='pgadmin', password=password,
                                   sslmode='disable', connect_timeout=3, autocommit=True)

        def runtime(server):
            # L'app : jamais l'administrateur (rôle applicatif cnp_runtime, comme sur GCP).
            return psycopg.connect(host='127.0.0.1', port=ports[server.key], dbname='appdb', user='cnp_runtime',
                                   password=RUNTIME_PASSWORD, sslmode='disable', connect_timeout=3, autocommit=True)

        def dump(server, password):
            def run():
                return docker('run', '--rm', '--network', token, '--env', f'PGPASSWORD={password}', IMAGE,
                              'pg_dump', '-h', server.key, '-U', 'pgadmin', '-d', 'appdb', *database.DUMP_FLAGS)
            return run

        for key in ports:  # attendre le serveur TCP final (pas l'instance temporaire d'initialisation)
            deadline = time.monotonic() + 60
            while True:
                try:
                    db = 'appdb' if key == 'fr' else 'postgres'
                    with connect(pair.primary if key == 'fr' else pair.copy, PASSWORD, db) as c:
                        c.execute('SELECT 1')
                    time.sleep(1)
                    with connect(pair.primary if key == 'fr' else pair.copy, PASSWORD, db) as c:
                        c.execute('SELECT 1')
                    break
                except psycopg.OperationalError:
                    if time.monotonic() > deadline:
                        raise
                    time.sleep(0.5)

        platform = FakePlatform(pair)
        logs = []
        engine = ar.Engine(platform, connect=connect, dump=dump, log=logs.append, sleep=time.sleep)
        app = lambda: runtime(pair.by_fqdn(platform.alias))  # noqa: E731 — l'app passe toujours par l'alias, en cnp_runtime
        rows = lambda server: [tuple(r) for r in connect(server, PASSWORD).execute('SELECT id, title FROM todos ORDER BY id').fetchall()]  # noqa: E731

        def converge(expected_active, timeout=60):
            deadline = time.monotonic() + timeout
            while True:
                result = engine.reconcile()[0]
                engine.ensure_roles()  # comme le job : rôle applicatif après chaque réconciliation
                if result.get('state') == 'REPLICATING' and result.get('active') == expected_active:
                    return result
                if time.monotonic() > deadline:
                    raise AssertionError(f'pas de convergence : {result}')
                time.sleep(1)

        def same(timeout=10):
            deadline = time.monotonic() + timeout
            while rows(pair.primary) != rows(pair.copy):
                if time.monotonic() > deadline:
                    raise AssertionError(f'divergence : fr={rows(pair.primary)} it={rows(pair.copy)}')
                time.sleep(0.2)
            return rows(pair.primary)

        steps = []
        # 0. Avant toute table : l'alias est créé vers la France, rien n'est répliqué.
        assert engine.reconcile()[0]['state'] == 'WAITING_SCHEMA' and platform.alias == 'fr'
        roles = {r['server']: r['state'] for r in engine.ensure_roles()}
        assert roles == {'fr': 'ROLE_READY', 'it': 'ROLE_READY'}, roles  # la base de la copie est créée par reconcile
        with app() as c:  # cnp_runtime : aucun droit d'administration
            assert c.execute("SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles "
                             "WHERE rolname = 'cnp_runtime'").fetchone()[0] is False
            for forbidden in ('CREATE DATABASE pirate', 'CREATE ROLE pirate', 'ALTER ROLE pgadmin PASSWORD \'x\''):
                try:
                    c.execute(forbidden)
                    raise AssertionError(f'cnp_runtime a pu faire : {forbidden}')
                except psycopg.errors.InsufficientPrivilege:
                    pass
        with app() as c:
            c.execute('CREATE TABLE todos (id serial PRIMARY KEY, title text NOT NULL)')
            c.execute("INSERT INTO todos(title) VALUES ('un'), ('deux')")
        # status : observation seule.
        assert engine.reconcile(apply=False)[0]['state'] == 'NEEDS_RESYNC'
        # La base de l'app a été créée sur la copie par le premier reconcile (absente au départ, comme sur Azure) ; status
        # n'y a rien abonné.
        with connect(pair.copy, PASSWORD) as c:
            assert not ar.our_subscriptions(c)
        steps.append(('réplication initiale', converge('fr')['state']))
        with app() as c:
            c.execute("INSERT INTO todos(title) VALUES ('trois')")
        steps.append(('écriture répliquée', same()))

        # 1. Bascule planifiée France -> Italie, sans perte ; la séquence est recalée.
        switched = engine.switch(pair)
        assert platform.alias == 'it'
        with app() as c:
            new_id = c.execute("INSERT INTO todos(title) VALUES ('écrit en Italie') RETURNING id").fetchone()[0]
        assert new_id == 4, new_id
        with connect(pair.primary, PASSWORD) as c:  # l'ancien actif est en lecture seule
            try:
                c.execute("INSERT INTO todos(title) VALUES ('interdit')")
                raise AssertionError("l'ancien actif accepte encore des écritures")
            except psycopg.errors.ReadOnlySqlTransaction:
                pass
        steps.append(('bascule vers it', {'pause_ms': switched['write_pause_ms']}))
        converge('it')
        steps.append(('France réabonnée à l\'Italie', same()))

        # 2. Retour planifié vers la France.
        engine.switch(pair)
        assert platform.alias == 'fr'
        with app() as c:
            assert c.execute("INSERT INTO todos(title) VALUES ('retour en France') RETURNING id").fetchone()[0] == 5
        converge('fr')
        steps.append(('retour vers fr', same()))

        # 3. Panne de la France : failover vers l'Italie.
        with app() as c:
            c.execute("INSERT INTO todos(title) VALUES ('avant la panne')")
        same()
        docker('pause', containers[0])
        refused = False
        try:
            engine.switch(pair)
        except RuntimeError:
            refused = True
        assert refused, 'switch accepté alors que la France ne répond pas'
        engine.failover(pair, attempts=1)
        assert platform.alias == 'it'
        with app() as c:
            assert c.execute("INSERT INTO todos(title) VALUES ('pendant la panne') RETURNING id").fetchone()[0] == 7
        assert engine.reconcile()[0]['state'] == 'STANDBY_UNREACHABLE'
        docker('unpause', containers[0])
        converge('it')
        steps.append(('France revenue, réabonnée', same()))

        # 4. Migration de schéma sur l'actif : la copie est reconstruite.
        with app() as c:
            c.execute('ALTER TABLE todos ADD COLUMN done boolean NOT NULL DEFAULT false')
            c.execute("INSERT INTO todos(title, done) VALUES ('après migration', true)")
        converge('it')
        with connect(pair.primary, PASSWORD) as c:
            assert c.execute("SELECT count(*) FROM information_schema.columns WHERE table_name='todos' AND column_name='done'").fetchone()[0] == 1
        steps.append(('migration reprise', same()))

        # 5. Retour final en France, puis état stable.
        engine.switch(pair)
        converge('fr')
        final = same()
        assert [t for _, t in final] == ['un', 'deux', 'trois', 'écrit en Italie', 'retour en France', 'avant la panne',
                                         'pendant la panne', 'après migration'], final
        steps.append(('retour final en France', len(final)))

        # 6. Option C : panne de la France, bascule AUTOMATIQUE, puis retour automatique une fois la France répliquée.
        engine.auto = ar.AutoPolicy(failover_after=3, freshness=600, failback_after=4, restart_grace=3)
        assert engine.reconcile()[0]['state'] == 'REPLICATING'  # mémoire : dernière réplication saine
        with app() as c:
            c.execute("INSERT INTO todos(title, done) VALUES ('avant la panne auto', false)")
        same()
        docker('pause', containers[0])
        first = engine.reconcile()[0]
        assert first['state'] == 'ACTIVE_UNREACHABLE' and first['auto'].startswith('waiting-failover'), first
        time.sleep(4)
        auto = engine.reconcile()[0]
        assert auto.get('event') == 'FAILED_OVER' and auto['reason'] == 'auto' and platform.alias == 'it', auto
        with app() as c:
            c.execute("INSERT INTO todos(title, done) VALUES ('pendant la panne auto', false)")
        docker('unpause', containers[0])
        converge('it')
        time.sleep(5)
        back = engine.reconcile()[0]
        assert back.get('event') == 'SWITCHED' and back['reason'] == 'auto-failback' and platform.alias == 'fr', back
        converge('fr')
        final = same()
        assert [t for _, t in final][-2:] == ['avant la panne auto', 'pendant la panne auto'], final
        steps.append(('C : bascule puis retour automatiques', len(final)))
        # Aucun mot de passe dans les journaux.
        assert not any(PASSWORD in line or RUNTIME_PASSWORD in line for line in logs)
        for name, detail in steps:
            print(f'OK  {name} : {detail}')
        print('Scénario Azure complet : OK')
    finally:
        for cid in containers:
            subprocess.run(['docker', 'unpause', cid], capture_output=True)
            subprocess.run(['docker', 'rm', '-f', cid], capture_output=True)
        if network:
            subprocess.run(['docker', 'network', 'rm', network], capture_output=True)


if __name__ == '__main__':
    main()
