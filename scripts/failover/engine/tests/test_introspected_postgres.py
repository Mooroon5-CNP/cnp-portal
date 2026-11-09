"""Contrat PostgreSQL par introspection : le schéma de l'application est lu dans sa base, jamais décrit à la main.

Une partie des tests tourne sans Docker (profil, commande pg_dump, câblage du bootstrap). Le scénario réaliste exige deux
PostgreSQL 15 jetables : python tests/run_docker_postgres.py --scenario introspected
"""
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bootstrap
import database
import postgres_contract

# Ce qu'une vraie application crée toute seule : serial, defaults, enum, unique, check, clé étrangère, extension,
# index GIN, identité GENERATED ALWAYS, vue, et une table sans clé primaire.
APP_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TYPE mood AS ENUM ('ok', 'meh', 'bad');
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  mood mood NOT NULL DEFAULT 'ok',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  done boolean NOT NULL DEFAULT false,
  tags text[] NOT NULL DEFAULT '{}',
  meta jsonb,
  UNIQUE (user_id, title));
CREATE INDEX todos_title_trgm ON todos USING gin (title gin_trgm_ops);
CREATE TABLE audit_log (at timestamptz NOT NULL DEFAULT now(), message text NOT NULL);
CREATE VIEW open_todos AS SELECT id, title FROM todos WHERE NOT done;
"""
PARAMS = {'host': 'source', 'port': 5432, 'user': 'cnp_local_admin', 'password': 'unused-local-trust',
          'dbname': 'cnp_local_admin', 'sslmode': 'disable'}


class ProfileTests(unittest.TestCase):
    def test_database_only_profile_is_the_introspected_form(self):
        profile = postgres_contract.encode({'database': 'appdb'})
        self.assertEqual(postgres_contract.decode(profile), {'database': 'appdb'})
        self.assertTrue(postgres_contract.is_introspected(profile))
        self.assertEqual(postgres_contract.database_name(profile), 'appdb')

    def test_declarative_and_legacy_profiles_no_longer_exist(self):
        # Forme déclarative et profils du pilote retirés le 07/11/2026 : refusés à l'encodage, jamais reconnus.
        with self.assertRaises(ValueError):
            postgres_contract.encode({'database': 'appdb', 'tables': [
                {'name': 'items', 'columns': [{'name': 'id', 'type': 'bigint', 'primary_key': True, 'identity': True}]}]})
        declarative = 'postgres:{"database":"appdb","tables":[]}'
        for profile in (declarative, 'pixelcalm', 'recipe', None):
            self.assertFalse(postgres_contract.is_introspected(profile))

    def test_unsafe_or_extra_fields_are_refused(self):
        for value in ({'database': 'x;DROP DATABASE x'}, {'database': 'App'}, {'database': ''}, {'database': 'ok', 'extra': 1},
                      {'tables': []}, {}):
            with self.assertRaises(ValueError):
                postgres_contract.encode(value)

    def test_tables_are_read_from_a_connection_never_guessed(self):
        profile = postgres_contract.encode({'database': 'appdb'})
        for function in (database.tables, database.sequences, database.published_tables):
            with self.assertRaisesRegex(ValueError, 'Connexion'):
                function(profile)


class DumpCommandTests(unittest.TestCase):
    PARAMS = {'host': '10.189.0.3', 'port': 5432, 'user': 'cnp_admin', 'password': 'p4ss-never-in-argv',
              'dbname': 'appdb', 'sslmode': 'verify-ca', 'sslrootcert': '/tmp/ca.pem'}

    def run_dump(self, returncode=0, stdout='-- dump\n', stderr='', environ=None):
        calls = []

        def fake(argv, env):
            calls.append((argv, env))
            return subprocess.CompletedProcess(argv, returncode, stdout, stderr)
        return calls, fake, environ

    def test_command_keeps_secrets_out_of_argv_and_the_environment_minimal(self):
        calls, fake, _ = self.run_dump()
        environ = {'PATH': '/usr/bin', 'AWS_SECRET_ACCESS_KEY': 'must-not-leak', 'HOME': '/home/cnp'}
        self.assertEqual(database.dump_schema(self.PARAMS, run=fake, environ=environ), '-- dump\n')
        argv, env = calls[0]
        self.assertEqual(argv[0], 'pg_dump')
        for flag in ('--schema-only', '--no-owner', '--no-privileges', '--no-publications', '--no-subscriptions',
                     '--schema=public', '--exclude-table=public.replication_barrier', '--exclude-table=public.cnp_recovery'):
            self.assertIn(flag, argv)
        self.assertNotIn('p4ss-never-in-argv', ' '.join(argv))
        self.assertEqual(env['PGPASSWORD'], 'p4ss-never-in-argv')
        self.assertEqual((env['PGHOST'], env['PGPORT'], env['PGUSER'], env['PGDATABASE']), ('10.189.0.3', '5432', 'cnp_admin', 'appdb'))
        self.assertEqual((env['PGSSLMODE'], env['PGSSLROOTCERT']), ('verify-ca', '/tmp/ca.pem'))
        self.assertNotIn('AWS_SECRET_ACCESS_KEY', env)

    def test_binary_can_be_overridden_for_a_matching_client_version(self):
        calls, fake, _ = self.run_dump()
        database.dump_schema(self.PARAMS, run=fake, environ={'PATH': '/usr/bin', 'CNP_PG_DUMP': '/usr/lib/postgresql/15/bin/pg_dump'})
        self.assertEqual(calls[0][0][0], '/usr/lib/postgresql/15/bin/pg_dump')

    def test_failure_never_echoes_server_output(self):
        _, fake, _ = self.run_dump(returncode=1, stdout='', stderr='FATAL: password authentication failed for user "cnp_admin"')
        with self.assertRaises(ValueError) as caught:
            database.dump_schema(self.PARAMS, run=fake, environ={'PATH': '/usr/bin'})
        self.assertNotIn('cnp_admin', str(caught.exception))
        self.assertNotIn('password', str(caught.exception).lower().replace('mot de passe', ''))


class ExecutableDumpTests(unittest.TestCase):
    def test_only_the_psql_restrict_lines_are_removed(self):
        script = ('--\n\\restrict aB3xYz09\n\nSET statement_timeout = 0;\nCREATE TABLE public.t (a text DEFAULT \'x\');\n'
                  'CREATE FUNCTION public.f() RETURNS text AS $$\n\\backslash line inside a body\n$$ LANGUAGE sql;\n\\unrestrict aB3xYz09\n')
        result = database.executable_dump(script)
        self.assertNotIn('restrict', result)
        self.assertIn('CREATE TABLE public.t', result)
        self.assertIn('\\backslash line inside a body', result)        # le reste est laissé intact

    def test_public_schema_creation_becomes_idempotent(self):
        result = database.executable_dump('CREATE SCHEMA public;\nCREATE SCHEMA billing;\n')
        self.assertIn('CREATE SCHEMA IF NOT EXISTS public;', result)
        self.assertIn('CREATE SCHEMA billing;', result)                # aucune autre ligne n'est réécrite

    def test_settings_unknown_to_the_target_are_dropped_and_known_ones_kept(self):
        script = ("SET statement_timeout = 0;\nSET transaction_timeout = 0;\nSET check_function_bodies = false;\n"
                  "SELECT pg_catalog.set_config('search_path', '', false);\nSET default_table_access_method = heap;\n")
        known = {'statement_timeout', 'check_function_bodies', 'default_table_access_method'}
        result = database.executable_dump(script, known)
        self.assertNotIn('transaction_timeout', result)
        for kept in ('SET statement_timeout = 0;', 'SET check_function_bodies = false;', 'SET default_table_access_method = heap;',
                     "SELECT pg_catalog.set_config('search_path', '', false);"):
            self.assertIn(kept, result)
        self.assertIn('transaction_timeout', database.executable_dump(script))      # sans liste connue : rien n'est retiré

    def test_an_unexpected_meta_command_is_not_silently_dropped(self):
        self.assertIn('\\connect other', database.executable_dump('\\connect other\nSELECT 1;\n'))


class BootstrapWiringTests(unittest.TestCase):
    def config(self, profile=None):
        prefix = 'arn:aws:secretsmanager:eu-west-3:804210702561:secret:'
        return {'app': 'fixture-app', 'profile': profile or postgres_contract.encode({'database': 'appdb'}),
                'source': {'host': '10.189.0.3', 'secret_arn': prefix + 'cnp/failover/fixture-app/source-admin-AbCd12', 'ca_pem': 'TEST-CA'},
                'target': {'host': 'fixture.abcdef.eu-west-3.rds.amazonaws.com', 'secret_arn': prefix + 'rds!db-fixture-AbCd12', 'ca_pem': 'TEST-CA'},
                'runtime_secret_arn': prefix + 'cnp/failover/fixture-app/runtime-AbCd12',
                'bootstrap_secret_arn': prefix + 'cnp/failover/fixture-app/bootstrap-AbCd12',
                'subscription_ca_path_on_rds': None, 'subscription_tls_mode': 'wireguard-tls',
                'acknowledge_wireguard_subscriber_trust': True}

    def test_restore_schema_needs_both_sides(self):
        with patch.object(bootstrap.ssl, 'create_default_context'):
            bootstrap.validate(self.config(), 'restore-schema')
            broken = self.config()
            del broken['source']
            with self.assertRaises(ValueError):
                bootstrap.validate(broken, 'restore-schema')

    def test_inspect_source_is_read_only_and_needs_only_the_source(self):
        with patch.object(bootstrap.ssl, 'create_default_context'):
            config = self.config()
            config['target'] = {}                          # seul le côté source est contrôlé pour une lecture de la source
            bootstrap.validate(config, 'inspect-source')
            with self.assertRaises(ValueError):
                bootstrap.validate(config, 'restore-schema')
        seen = {}

        class FakeSQL:
            @contextmanager
            def connection(self, config, side):
                seen.setdefault('sides', []).append(side)
                yield Mock(name=side)

        with patch.object(bootstrap.ssl, 'create_default_context'), \
                patch.object(database, 'inspect_source', return_value={'schema_ready': False, 'tables': 0}) as inspect:
            result = bootstrap.execute(self.config(), 'inspect-source', Mock(), sql=FakeSQL())
        inspect.assert_called_once()
        self.assertEqual(seen['sides'], ['source'])
        self.assertFalse(result['schema_ready'])
        self.assertTrue(result['completed'])

    def test_restore_schema_reads_the_source_and_writes_only_the_target(self):
        sides = {}

        class FakeSQL:
            @contextmanager
            def connection(self, config, side):
                sides[side] = Mock(name=side)
                yield sides[side]

            def dump_schema(self, config, side):
                self.dumped = side
                return 'CREATE TABLE public.t ();'

        sql = FakeSQL()
        with patch.object(bootstrap.ssl, 'create_default_context'), patch.object(database, 'copy_schema') as copy:
            copy.side_effect = lambda source, target, dump: {'tables': 3, 'dump': dump(), 'source_is_source': source is sides['source'],
                                                             'target_is_target': target is sides['target']}
            result = bootstrap.execute(self.config(), 'restore-schema', Mock(), sql=sql)
        self.assertEqual(sql.dumped, 'source')
        self.assertTrue(result['source_is_source'] and result['target_is_target'])
        self.assertEqual(result['tables'], 3)


# ---------------------------------------------------------------------------------------------------------------------
# Scénario réaliste sur deux PostgreSQL 15 jetables (Docker).
# ---------------------------------------------------------------------------------------------------------------------
def docker_run(argv, env):
    """Exécute le vrai pg_dump 15 depuis l'image du serveur, sur le réseau Docker du test."""
    command = ['docker', 'run', '--rm', '--network', os.environ['CNP_LOCAL_DOCKER_NETWORK']]
    for key in ('PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSSLMODE', 'PGCONNECT_TIMEOUT', 'PGAPPNAME'):
        command += ['-e', f'{key}={env[key]}']
    dump_image = os.environ.get('CNP_LOCAL_DUMP_IMAGE')        # ex. l'image de production du bootstrap (client plus récent)
    if dump_image:
        command += ['-e', 'PGPASSWORD', '--entrypoint', argv[0], dump_image, *argv[1:]]
    else:
        command += ['-e', 'PGPASSWORD', os.environ['CNP_LOCAL_IMAGE'], *argv]
    return subprocess.run(command, env={**os.environ, 'PGPASSWORD': env['PGPASSWORD']}, capture_output=True, text=True)


def eventually(check, message, timeout=45):
    deadline = time.monotonic() + timeout
    while not check():
        if time.monotonic() > deadline:
            raise AssertionError(message)
        time.sleep(0.2)


@unittest.skipUnless(os.getenv('CNP_LOCAL_INTROSPECTED_TEST') == '1', 'Lanceur Docker local explicite requis')
class RealisticApplicationTests(unittest.TestCase):
    def setUp(self):
        import psycopg
        self.psycopg = psycopg
        self.source_dsn = os.environ['CNP_LOCAL_SOURCE_DSN']
        self.target_dsn = os.environ['CNP_LOCAL_TARGET_DSN']

    def dump(self, dbname='cnp_local_admin'):
        return lambda: database.dump_schema({**PARAMS, 'dbname': dbname}, run=docker_run)

    def scratch(self, dsn, name):
        from psycopg.conninfo import make_conninfo
        with self.psycopg.connect(dsn, autocommit=True) as admin:
            if not admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone():
                admin.execute(f'CREATE DATABASE {name}')
        return self.psycopg.connect(make_conninfo(dsn, dbname=name), autocommit=True)

    def test_a_non_superuser_admin_can_prepare_tables_created_by_the_application(self):
        """Comme sur Cloud SQL : l'administrateur n'est pas superutilisateur et l'application est propriétaire de ses tables."""
        from psycopg.conninfo import make_conninfo
        profile = postgres_contract.encode({'database': 'cloudsql_like'})
        with self.scratch(self.source_dsn, 'cloudsql_like') as root:
            for statement in ("CREATE ROLE cloudsql_admin LOGIN CREATEROLE", "CREATE ROLE cnp_runtime LOGIN",
                              "CREATE ROLE cnp_replication LOGIN REPLICATION",
                              "GRANT CREATE ON DATABASE cloudsql_like TO cloudsql_admin", "GRANT CREATE ON SCHEMA public TO cloudsql_admin, cnp_runtime"):
                try:
                    root.execute(statement)
                except self.psycopg.errors.DuplicateObject:
                    pass
            root.execute('SET ROLE cnp_runtime')                       # l'application crée elle-même ses tables
            root.execute("CREATE TABLE todos (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, title text NOT NULL)")
            root.execute("CREATE TABLE audit_log (at timestamptz NOT NULL DEFAULT now(), message text NOT NULL)")
            root.execute("INSERT INTO todos(title) VALUES ('écrire')")
            root.execute('RESET ROLE')
        with self.psycopg.connect(make_conninfo(self.source_dsn, dbname='cloudsql_like', user='cloudsql_admin'), autocommit=True) as admin:
            self.assertFalse(admin.execute('SELECT rolsuper FROM pg_roles WHERE rolname=current_user').fetchone()[0])
            database.install_schema(admin, profile)
            with self.assertRaises(self.psycopg.errors.InsufficientPrivilege):      # ce qui a bloqué G5 sur la vraie Cloud SQL
                with admin.transaction():
                    database.configure_runtime(admin, False, profile)
            database.adopt_runtime_tables(admin)
            report = database.prepare_source_schema(admin)
            self.assertEqual(report['replica_identity_full'], ['audit_log'])
            database.configure_runtime(admin, False, profile)
            database.publisher(admin, profile)
            self.assertEqual(database.published_tables(profile, admin),
                             {('public', name) for name in ('todos', 'audit_log', 'replication_barrier')})
            self.assertTrue(admin.execute("SELECT has_table_privilege('cnp_replication', 'public.todos', 'SELECT')").fetchone()[0])
            database.adopt_runtime_tables(admin)                                  # rejouable

    def test_a_real_application_survives_replication_and_promotion(self):
        profile = postgres_contract.encode({'database': 'cnp_local_admin'})
        with self.psycopg.connect(self.source_dsn, autocommit=True) as source, self.psycopg.connect(self.target_dsn, autocommit=True) as target:
            for conn in (source, target):
                # Les rôles sont communs au serveur : un autre test de ce scénario a pu déjà les créer, à l'identique.
                for statement in ('CREATE ROLE cnp_runtime LOGIN', 'CREATE ROLE cnp_replication LOGIN REPLICATION'):
                    try:
                        conn.execute(statement)
                    except self.psycopg.errors.DuplicateObject:
                        pass
            # L'application crée son propre schéma et y met des données, avant que CNP n'intervienne.
            source.execute(APP_SCHEMA)
            source.execute("INSERT INTO users(email, mood) VALUES ('a@example.test', 'meh'), ('b@example.test', DEFAULT)")
            source.execute("INSERT INTO todos(user_id, title, tags, meta) VALUES (1, 'écrire', '{work,urgent}', '{\"p\": 1}'), (2, 'lire', DEFAULT, NULL)")
            source.execute("INSERT INTO audit_log(message) VALUES ('boot'), ('seed')")

            database.install_schema(source, profile)
            report = database.prepare_source_schema(source)
            self.assertEqual(report['replica_identity_full'], ['audit_log'])
            self.assertIn('pg_trgm', report['extensions'])
            database.configure_runtime(source, False, profile)
            database.publisher(source, profile)
            self.assertEqual(database.published_tables(profile, source),
                             {('public', name) for name in ('users', 'todos', 'audit_log', 'replication_barrier')})

            restored = database.copy_schema(source, target, self.dump())
            self.assertEqual((restored['tables'], restored['already_restored']), (3, False))
            database.install_schema(target, profile)
            database.configure_runtime(target, True, profile)
            self.assert_target_schema_is_complete(target)

            database.subscribe(target, os.environ['CNP_LOCAL_REPLICATION_DSN'], profile)
            eventually(lambda: database.progress(target, profile)['tables_ready'], 'Copie initiale incomplète')

            source.execute("UPDATE users SET mood='bad' WHERE id=1")
            source.execute("INSERT INTO todos(user_id, title) VALUES (2, 'courir')")
            source.execute("UPDATE audit_log SET message='boot-2' WHERE message='boot'")   # exige REPLICA IDENTITY FULL
            source.execute("DELETE FROM audit_log WHERE message='seed'")
            eventually(lambda: target.execute('SELECT count(*) FROM todos').fetchone()[0] == 3, 'Écritures non rejouées')
            eventually(lambda: target.execute("SELECT array_agg(message) FROM audit_log").fetchone()[0] == ['boot-2'], 'Table sans clé primaire mal répliquée')
            self.assertEqual(target.execute('SELECT mood::text FROM users WHERE id=1').fetchone()[0], 'bad')

            status = database.replication_status(source, target, profile)
            self.assertTrue(status['schema_in_sync'])
            source.execute('ALTER TABLE users ADD COLUMN nickname text')
            self.assertFalse(database.replication_status(source, target, profile)['schema_in_sync'])
            source.execute('ALTER TABLE users DROP COLUMN nickname')
            self.assertTrue(database.replication_status(source, target, profile)['schema_in_sync'])

            # Mise à jour de l'application : sa migration change le schéma de GCP (colonne et table ajoutées). La réplication
            # logique ne transporte pas ce changement : la copie AWS est reconstruite depuis GCP, comme à l'initialisation.
            source.execute('ALTER TABLE users ADD COLUMN nickname text')
            source.execute('CREATE TABLE notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL)')
            source.execute("INSERT INTO notes(body) VALUES ('nouvelle table')")
            source.execute("UPDATE users SET nickname='alpha' WHERE id=1")
            self.assertFalse(database.replication_status(source, target, profile)['schema_in_sync'])
            database.reset_target(target)
            self.assertIsNone(target.execute("SELECT to_regclass('public.users')").fetchone()[0])
            self.assertIsNone(source.execute("SELECT 1 FROM pg_replication_slots WHERE slot_name=%s", (database.SUBSCRIPTION,)).fetchone())
            database.configure_runtime(source, False, profile)
            database.publisher(source, profile)                                   # la publication suit la nouvelle table
            self.assertIn(('public', 'notes'), set(source.execute('SELECT schemaname,tablename FROM pg_publication_tables').fetchall()))
            self.assertFalse(database.copy_schema(source, target, self.dump())['already_restored'])
            database.install_schema(target, profile)
            database.configure_runtime(target, True, profile)
            database.subscribe(target, os.environ['CNP_LOCAL_REPLICATION_DSN'], profile)
            eventually(lambda: database.progress(target, profile)['tables_ready'], 'Recopie incomplète après la migration')
            eventually(lambda: target.execute("SELECT nickname FROM users WHERE id=1").fetchone() == ('alpha',), 'Nouvelle colonne non recopiée')
            source.execute("INSERT INTO notes(body) VALUES ('après la reconstruction')")
            eventually(lambda: target.execute('SELECT count(*) FROM notes').fetchone()[0] == 2, 'Nouvelle table non répliquée')
            self.assertTrue(database.replication_status(source, target, profile)['schema_in_sync'])
            with self.assertRaisesRegex(ValueError, 'ouverte'):                   # jamais sur une copie promue
                target.execute('ALTER ROLE cnp_runtime LOGIN')
                database.reset_target(target)
            target.execute('ALTER ROLE cnp_runtime NOLOGIN')

            result = database.promote_after_fence(source, target, profile=profile)
            self.assertEqual(result['state'], 'AWS_ACTIVE')
            self.assert_application_works_after_promotion(target)
            self.assert_failback_to_gcp(source, target, profile)

    def runtime(self, dsn):
        from psycopg.conninfo import make_conninfo
        return self.psycopg.connect(make_conninfo(dsn, user='cnp_runtime'), autocommit=True)

    def assert_failback_to_gcp(self, source, target, profile):
        """Retour manuel : AWS (promu, avec de nouvelles écritures) recopié sur GCP, puis GCP de nouveau source répliquée."""
        count = lambda conn, table: conn.execute(f'SELECT count(*) FROM {table}').fetchone()[0]
        self.assertEqual((count(source, 'users'), count(target, 'users'), count(target, 'todos')), (2, 3, 4))
        # GCP revenu mais encore ouvert : le worker ne l'a pas clôturé, aucun retour.
        source.execute('ALTER ROLE cnp_runtime LOGIN')
        with self.assertRaisesRegex(ValueError, 'clôturé'):
            database.failback_sync(source, target, profile)
        source.execute('ALTER ROLE cnp_runtime NOLOGIN')

        # Lecture seule d'AWS : les sessions existantes sont coupées, les nouvelles lisent mais n'écrivent plus.
        before = self.runtime(self.target_dsn)
        database.failback_freeze_target(target)
        with self.assertRaises(self.psycopg.OperationalError):
            before.execute('SELECT 1')
        with self.runtime(self.target_dsn) as reader:
            self.assertEqual(reader.execute('SELECT count(*) FROM users').fetchone()[0], 3)
            with self.assertRaises(self.psycopg.errors.ReadOnlySqlTransaction):
                reader.execute("INSERT INTO users(email) VALUES ('gel@example.test')")
        database.failback_unfreeze_target(target)

        # Une copie qui ne retrouve pas les données d'AWS est annulée : GCP inchangé, AWS reprend les écritures.
        source.execute("CREATE FUNCTION public.tamper() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.message := NEW.message || '!'; RETURN NEW; END$$")
        source.execute('CREATE TRIGGER tamper BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION public.tamper()')
        with self.assertRaisesRegex(ValueError, 'différente'):
            database.failback_sync(source, target, profile)
        self.assertEqual((count(source, 'users'), count(source, 'todos')), (2, 3))
        self.assertEqual(database.recovery_state(target)['state'], 'AWS_ACTIVE')
        self.assertIsNone(target.execute("SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='cnp_runtime'").fetchone())
        with self.runtime(self.target_dsn) as writer:
            writer.execute("INSERT INTO audit_log(message) VALUES ('écrit sur AWS après un retour annulé')")
        source.execute('DROP TRIGGER tamper ON audit_log')
        source.execute('DROP FUNCTION public.tamper()')

        expected = database.table_checksums(target, database.tables(profile, target))
        report = database.failback_sync(source, target, profile)
        self.assertEqual((report['state'], report['tables'], report['checksums_equal']), ('GCP_OPEN', 4, True))         # users, todos, audit_log, notes
        self.assertEqual(database.table_checksums(source, database.tables(profile, source)), expected)
        self.assertEqual(database.recovery_state(target)['state'], 'FAILBACK_COPIED')
        self.assertTrue(database.runtime_can_login(source))
        self.assertFalse(database.runtime_can_login(target))           # jamais deux bases ouvertes en écriture
        self.assertIsNone(target.execute("SELECT 1 FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole WHERE r.rolname='cnp_runtime'").fetchone())
        self.assertTrue(database.failback_sync(source, target, profile)['already_done'])     # rejouable
        self.assertIsNone(database.recovery_state(source))
        # Séquences recalées après les identifiants écrits sur AWS ; contraintes remises et actives.
        with self.runtime(self.source_dsn) as app:
            self.assertEqual(app.execute("INSERT INTO users(email) VALUES ('d@example.test') RETURNING id").fetchone()[0], 4)
            self.assertEqual(app.execute("INSERT INTO todos(user_id, title) VALUES (4, 'retour sur GCP') RETURNING id").fetchone()[0], 5)
            with self.assertRaises(self.psycopg.errors.ForeignKeyViolation):
                app.execute("INSERT INTO todos(user_id, title) VALUES (999, 'orphelin')")
        self.assertEqual(source.execute("SELECT title FROM todos WHERE id=4").fetchone()[0], 'après bascule')

        # La copie AWS repart de zéro depuis GCP, par le chemin de l'initialisation (mêmes gardes).
        with self.assertRaisesRegex(ValueError, 'GCP fermé'):
            source.execute('ALTER ROLE cnp_runtime NOLOGIN')
            database.failback_reset_target(source, target)
        source.execute('ALTER ROLE cnp_runtime LOGIN')
        database.failback_reset_target(source, target)
        self.assertIsNone(source.execute('SELECT 1 FROM pg_replication_slots WHERE slot_name=%s', (database.SUBSCRIPTION,)).fetchone())
        self.assertIsNone(target.execute("SELECT to_regclass('public.users')").fetchone()[0])
        database.failback_reset_target(source, target)                 # rejouable sur une copie déjà vidée
        database.guard_bootstrap(source, source=True)
        database.install_schema(source, profile)
        database.prepare_source_schema(source)
        database.configure_runtime(source, False, profile)
        database.publisher(source, profile)
        self.assertFalse(database.copy_schema(source, target, self.dump())['already_restored'])
        database.guard_bootstrap(target)
        database.install_schema(target, profile)
        database.configure_runtime(target, True, profile)
        database.subscribe(target, os.environ['CNP_LOCAL_REPLICATION_DSN'], profile)
        eventually(lambda: database.progress(target, profile)['tables_ready'], 'Recopie incomplète après le retour')
        eventually(lambda: count(target, 'users') == 4, 'Données GCP non recopiées sur AWS')
        source.execute("INSERT INTO audit_log(message) VALUES ('répliqué après le retour')")
        eventually(lambda: target.execute("SELECT 1 FROM audit_log WHERE message='répliqué après le retour'").fetchone(), 'Réplication non relancée')
        self.assertTrue(database.replication_status(source, target, profile)['schema_in_sync'])
        self.assertIsNone(database.recovery_state(target))
        self.assertFalse(database.runtime_can_login(target))

        # Le cycle recommence : nouvelle bascule vers AWS, sans perte, et AWS ouvert en écriture (lecture seule bien levée).
        source.execute("INSERT INTO users(email) VALUES ('e@example.test')")
        eventually(lambda: count(target, 'users') == 5, 'Écriture GCP non répliquée avant la seconde bascule')
        self.assertEqual(database.promote_after_fence(source, target, profile=profile)['state'], 'AWS_ACTIVE')
        with self.runtime(self.target_dsn) as app:
            self.assertEqual(app.execute("INSERT INTO users(email) VALUES ('f@example.test') RETURNING id").fetchone()[0], 6)
        # Et un second retour vers GCP.
        self.assertTrue(database.failback_sync(source, target, profile)['checksums_equal'])
        self.assertEqual(count(source, 'users'), 6)

    def assert_target_schema_is_complete(self, target):
        """Ce que l'ancien contrat déclaratif ne recréait pas sur le standby."""
        one = lambda query, *args: target.execute(query, args).fetchone()
        self.assertIn('now()', one("SELECT column_default FROM information_schema.columns WHERE table_name='users' AND column_name='created_at'")[0])
        self.assertIn('nextval', one("SELECT column_default FROM information_schema.columns WHERE table_name='users' AND column_name='id'")[0])
        self.assertIn("'ok'", one("SELECT column_default FROM information_schema.columns WHERE table_name='users' AND column_name='mood'")[0])
        for name in ('users_email_key', 'todos_user_id_fkey', 'todos_title_check', 'todos_user_id_title_key'):
            self.assertIsNotNone(one('SELECT 1 FROM pg_constraint WHERE conname=%s', name), name)
        self.assertIsNotNone(one("SELECT 1 FROM pg_indexes WHERE indexname='todos_title_trgm'"))
        self.assertIsNotNone(one("SELECT 1 FROM pg_type WHERE typname='mood' AND typtype='e'"))
        self.assertIsNotNone(one("SELECT 1 FROM pg_extension WHERE extname='pg_trgm'"))
        self.assertIsNotNone(one("SELECT 1 FROM pg_views WHERE viewname='open_todos'"))
        self.assertEqual(one("SELECT relreplident FROM pg_class WHERE relname='audit_log'")[0], 'f')

    def assert_application_works_after_promotion(self, target):
        mood, created, new_id = target.execute("INSERT INTO users(email) VALUES ('c@example.test') RETURNING mood::text, created_at, id").fetchone()
        self.assertEqual((mood, new_id), ('ok', 3))              # default d'enum et séquence alignée après le max répliqué
        self.assertIsNotNone(created)                            # default now() recréé
        self.assertEqual(target.execute("INSERT INTO todos(user_id, title) VALUES (3, 'après bascule') RETURNING id").fetchone()[0], 4)
        for statement, error in [("INSERT INTO users(email) VALUES ('a@example.test')", self.psycopg.errors.UniqueViolation),
                                 ("INSERT INTO todos(user_id, title) VALUES (999, 'orphelin')", self.psycopg.errors.ForeignKeyViolation),
                                 ("INSERT INTO todos(user_id, title) VALUES (1, '')", self.psycopg.errors.CheckViolation)]:
            with self.assertRaises(error):
                target.execute(statement)
        self.assertEqual(target.execute('SELECT count(*) FROM open_todos').fetchone()[0], 4)

    def test_inspection_waits_for_the_application_instead_of_failing(self):
        with self.scratch(self.source_dsn, 't_inspect') as conn:
            empty = database.inspect_source(conn)
            self.assertEqual((empty['schema_ready'], empty['tables'], empty['unsupported']), (False, 0, []))
            conn.execute('CREATE TABLE notes (id serial PRIMARY KEY, body text)')
            ready = database.inspect_source(conn)
            self.assertEqual((ready['schema_ready'], ready['tables']), (True, 1))
            conn.execute('CREATE SCHEMA other; CREATE TABLE other.stuff (id int)')
            blocked = database.inspect_source(conn)
            self.assertFalse(blocked['schema_ready'])
            self.assertTrue(any('other.stuff' in item for item in blocked['unsupported']))
            self.assertEqual(conn.execute("SELECT relreplident FROM pg_class WHERE relname='notes'").fetchone()[0], 'd')   # aucune écriture

    def test_an_empty_source_is_explained_not_replicated(self):
        with self.scratch(self.source_dsn, 't_empty') as conn:
            with self.assertRaisesRegex(ValueError, 'migrations'):
                database.require_supported(conn)

    def test_unsupported_objects_are_named_before_any_change(self):
        with self.scratch(self.source_dsn, 't_unsupported') as conn:
            conn.execute("""
                CREATE SCHEMA billing; CREATE TABLE billing.invoices (id int PRIMARY KEY);
                CREATE TABLE events (id int, at date) PARTITION BY RANGE (at);
                CREATE SEQUENCE loose_seq;
                CREATE TABLE ticks (n bigint PRIMARY KEY); CREATE SEQUENCE ticks_seq INCREMENT 5 OWNED BY ticks.n;
                CREATE MATERIALIZED VIEW stats AS SELECT 1 AS x;""")
            with self.assertRaises(ValueError) as caught:
                database.prepare_source_schema(conn)
            message = str(caught.exception)
            for name in ('billing.invoices', 'events', 'loose_seq', 'ticks_seq', 'stats'):
                self.assertIn(name, message)
            self.assertEqual(conn.execute("SELECT relreplident FROM pg_class WHERE relname='ticks'").fetchone()[0], 'd')   # rien modifié

    def test_restore_is_idempotent_and_never_migrates_a_different_target(self):
        schema = "CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL DEFAULT 'x');"
        with self.scratch(self.source_dsn, 't_idem') as source, self.scratch(self.target_dsn, 't_idem') as target:
            source.execute(schema)
            first = database.copy_schema(source, target, self.dump('t_idem'))
            again = database.copy_schema(source, target, self.dump('t_idem'))
            self.assertFalse(first['already_restored'])
            self.assertTrue(again['already_restored'])
            self.assertEqual(first['schema_fingerprint'], again['schema_fingerprint'])
            target.execute('ALTER TABLE items ADD COLUMN extra int')
            with self.assertRaisesRegex(ValueError, 'aucune migration'):
                database.copy_schema(source, target, self.dump('t_idem'))


if __name__ == '__main__':
    unittest.main()
