import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import replication_tls
import automation
import types
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bootstrap
import database
from psycopg.conninfo import conninfo_to_dict
import postgres_contract


def profile():
    prefix = "arn:aws:secretsmanager:eu-west-3:804210702561:secret:"
    return {"app": "fixture-app", "profile": postgres_contract.encode({"database": "pixelcalm"}),
        "source": {"host": "10.189.0.3", "secret_arn": prefix + "cnp/failover/fixture-app/source-admin-AbCd12", "ca_pem": "TEST-CA"},
        "target": {"host": "fixture.abcdef.eu-west-3.rds.amazonaws.com", "secret_arn": prefix + "rds!db-fixture-AbCd12", "ca_pem": "TEST-CA"},
        "runtime_secret_arn": prefix + "cnp/failover/fixture-app/runtime-AbCd12",
        "bootstrap_secret_arn": prefix + "cnp/failover/fixture-app/bootstrap-AbCd12",
        "subscription_ca_path_on_rds": "/server/fixture-ca.pem"}


class BootstrapTests(unittest.TestCase):
    def test_every_operation_is_offline_without_execute(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(bootstrap.ssl, "create_default_context"), \
                patch.object(bootstrap, "execute") as execute, patch("sys.stdout", new_callable=io.StringIO):
            path = Path(temp)/"profile.json"; path.write_text(json.dumps(profile()))
            for operation in ["prepare-source", "create-target-runtime", "prepare-target", "verify-native-tls", "subscribe", "monitor", "status"]:
                self.assertEqual(bootstrap.main([operation, "--config", str(path)]), 0)
            execute.assert_not_called()

    def test_replication_root_certificate_path_is_the_server_path(self):
        secrets = Mock()
        secrets.get_secret_value.return_value = {"SecretString": json.dumps({"app": "fixture-app", "schema_version": 1, "replication-password": "private-fixture"})}
        info = conninfo_to_dict(bootstrap.replication_dsn(profile(), secrets))
        self.assertEqual(info["sslrootcert"], "/server/fixture-ca.pem")
        self.assertEqual(info["user"], "cnp_replication")
        self.assertEqual(info["dbname"], "pixelcalm")
        self.assertEqual(info["sslmode"], "verify-ca")

    def test_missing_server_trust_path_cannot_be_replaced_by_local_tmp_ca(self):
        config = profile(); config["subscription_ca_path_on_rds"] = None
        with patch.object(bootstrap.ssl, "create_default_context"), self.assertRaises(ValueError):
            bootstrap.validate(config, "subscribe")

    def test_wireguard_mode_requires_explicit_acceptance_and_never_claims_certificate_verification(self):
        config = profile()
        config.update(subscription_tls_mode='wireguard-tls', subscription_ca_path_on_rds=None,
            acknowledge_wireguard_subscriber_trust=True)
        secrets=Mock()
        secrets.get_secret_value.return_value={'SecretString':json.dumps({'app':config['app'],
            'schema_version':1,'replication-password':'fixture-password'})}
        with patch.object(bootstrap.ssl,'create_default_context'):
            bootstrap.validate(config,'subscribe')
        info=conninfo_to_dict(bootstrap.replication_dsn(config,secrets))
        self.assertEqual(info['sslmode'],'require')
        self.assertNotIn('sslrootcert',info)
        config['acknowledge_wireguard_subscriber_trust']=False
        with patch.object(bootstrap.ssl,'create_default_context'), self.assertRaises(ValueError):
            bootstrap.validate(config,'subscribe')

    def test_native_probe_failure_stops_before_subscription_creation(self):
        sql = Mock(); sql.connection.return_value.__enter__ = Mock(return_value=Mock())
        sql.connection.return_value.__exit__ = Mock(return_value=False)
        with patch.object(bootstrap.ssl, "create_default_context"), patch.object(bootstrap, "replication_dsn", return_value="fixture"), \
                patch.object(database, "native_tls_probe", side_effect=ValueError("TLS")), patch.object(database, "subscribe") as subscribe:
            with self.assertRaises(ValueError):
                bootstrap.execute(profile(), "subscribe", Mock(), sql)
            subscribe.assert_not_called()

    def test_prepare_target_never_uses_master_password_for_runtime(self):
        secrets, sql, target = Mock(), Mock(), Mock()
        sql.connection.return_value.__enter__ = Mock(return_value=target)
        sql.connection.return_value.__exit__ = Mock(return_value=False)
        secrets.get_secret_value.return_value = {"SecretString": json.dumps({"username": "cnp_runtime", "password": "runtime-fixture"})}
        with patch.object(bootstrap.ssl, "create_default_context"), patch.object(database, "create_target_runtime") as create:
            bootstrap.execute(profile(), "create-target-runtime", secrets, sql)
            secrets.get_secret_value.assert_called_once_with(SecretId=profile()["runtime_secret_arn"])
            create.assert_called_once_with(target, "runtime-fixture")


class NativeTLSProbeTests(unittest.TestCase):
    def setUp(self):
        # Le schéma se lit dans la base : le faux serveur « découvre » une table applicative.
        patcher = patch.object(database, 'discover', return_value={'tables': ['pensees'], 'sequences': [], 'unsupported': [],
                                                                   'needs_full_identity': [], 'extensions': []})
        patcher.start()
        self.addCleanup(patcher.stop)

    dsn = "host=10.189.0.3 user=cnp_replication password=fixture dbname=pixelcalm sslmode=verify-ca sslrootcert=/server/fixture.pem"

    def connection(self, tables=None):
        conn = Mock()
        conn.execute.side_effect = [Mock(), Mock(fetchone=Mock(return_value=(123, False, None))),
            Mock(fetchall=Mock(return_value=tables if tables is not None else [("public", "pensees"), ("public", "replication_barrier")])), Mock()]
        return conn

    def test_probe_opens_no_slot_and_copies_no_data_then_removes_itself(self):
        conn = self.connection()
        result = database.native_tls_probe(conn, self.dsn, postgres_contract.encode({"database": "pixelcalm"}))
        self.assertTrue(result["native_tls_verified"])
        create = conn.execute.call_args_list[0].args[0].as_string()
        self.assertIn("create_slot=false", create)
        self.assertIn("enabled=false", create)
        self.assertIn("copy_data=false", create)
        self.assertIn("slot_name=NONE", create)
        self.assertIn("DROP SUBSCRIPTION", conn.execute.call_args_list[-1].args[0].as_string())

    def test_wrong_or_absent_publication_is_not_a_successful_probe(self):
        conn = self.connection(tables=[])
        with self.assertRaises(ValueError):
            database.native_tls_probe(conn, self.dsn, postgres_contract.encode({"database": "pixelcalm"}))
        self.assertIn("DROP SUBSCRIPTION", conn.execute.call_args_list[-1].args[0].as_string())

    def test_require_or_disable_is_never_reported_as_verified_tls(self):
        for mode in ("require", "disable", "prefer"):
            conn = Mock()
            with self.assertRaises(ValueError):
                database.native_tls_probe(conn, self.dsn.replace("verify-ca", mode), postgres_contract.encode({"database": "pixelcalm"}))
            conn.execute.assert_not_called()

    def test_connection_failure_does_not_start_copy_or_claim_tls_success(self):
        conn = Mock(); conn.execute.side_effect = RuntimeError("unavailable")
        with self.assertRaises(RuntimeError):
            database.native_tls_probe(conn, self.dsn, postgres_contract.encode({"database": "pixelcalm"}))
        self.assertEqual(conn.execute.call_count, 1)

    def test_explicit_private_tunnel_mode_reports_encryption_without_ca_verification(self):
        conn = self.connection()
        dsn = self.dsn.replace('sslmode=verify-ca sslrootcert=/server/fixture.pem','sslmode=require')
        result=database.native_tls_probe(conn,dsn,postgres_contract.encode({"database": "pixelcalm"}),True)
        self.assertTrue(result['native_tls_connected'])
        self.assertFalse(result['native_tls_verified'])
        self.assertEqual(result['subscriber_trust'],'wireguard-tls')

    def test_tunnel_trust_cannot_be_used_for_public_sql_or_unencrypted_replication(self):
        for dsn in [self.dsn.replace('10.189.0.3','8.8.8.8').replace('sslmode=verify-ca sslrootcert=/server/fixture.pem','sslmode=require'),
                self.dsn.replace('sslmode=verify-ca','sslmode=disable'),
                self.dsn.replace('sslmode=verify-ca','sslmode=prefer')]:
            conn=Mock()
            with self.assertRaises(ValueError):database.native_tls_probe(conn,dsn,postgres_contract.encode({"database": "pixelcalm"}),True)
            conn.execute.assert_not_called()


class BootstrapSafetyTests(unittest.TestCase):
    def test_saved_recovery_blocks_reinitialization(self):
        conn = Mock()
        conn.execute.side_effect = [Mock(fetchone=Mock(return_value=("cnp_recovery",))), Mock(fetchone=Mock(return_value=(True,)))]
        with self.assertRaisesRegex(ValueError, "Reprise déjà engagée"):
            database.guard_bootstrap(conn)
        self.assertEqual(conn.execute.call_count, 2)

    def test_existing_subscription_blocks_reinitialization(self):
        conn = Mock()
        conn.execute.side_effect = [Mock(fetchone=Mock(return_value=(None,))), Mock(fetchone=Mock(return_value=(True,)))]
        with self.assertRaisesRegex(ValueError, "Abonnement existant"):
            database.guard_bootstrap(conn)

    def test_closed_publisher_cannot_be_reopened_by_prepare_source(self):
        conn = Mock()
        conn.execute.side_effect = [Mock(fetchone=Mock(return_value=(None,))), Mock(fetchone=Mock(return_value=None)),
            Mock(fetchone=Mock(return_value=(True,))), Mock(fetchone=Mock(return_value=(False,)))]
        with self.assertRaisesRegex(ValueError, "Source déjà clôturée"):
            database.guard_bootstrap(conn, source=True)

    def test_role_creation_refuses_weak_password_before_any_sql(self):
        conn = Mock()
        with self.assertRaises(ValueError):
            database.create_target_runtime(conn, "weak")
        conn.execute.assert_not_called()

    def test_no_password_rotation_of_existing_role(self):
        conn = Mock()
        with patch.object(database, "guard_bootstrap"), self.assertRaisesRegex(ValueError, "Rôle existant"):
            database.create_target_runtime(conn, "x"*48)
        self.assertEqual(conn.execute.call_count, 1)


if __name__ == "__main__":
    unittest.main()


class ConnectTimeoutTests(unittest.TestCase):
    """Une connexion à Cloud SQL (db-f1-micro) prend 5 à 6 s par le tunnel : 5 s faisait échouer une connexion sur deux."""

    def test_operator_and_worker_connections_wait_long_enough(self):
        self.assertGreaterEqual(automation.CONNECT_TIMEOUT, 15)
        seen = {}
        class Fake:
            def __enter__(self): return self
            def __exit__(self, *args): return False
        fake = types.SimpleNamespace(connect=lambda **kwargs: seen.update(kwargs) or Fake())
        secrets = Mock()
        secrets.get_secret_value.return_value = {"SecretString": json.dumps({"username": "postgres", "password": "x"})}
        app = {"profile": 'postgres:{"database":"appdb"}', "source": {"host": "10.189.0.6", "ca_pem": "CA", "secret_arn": "arn"}}
        with patch.dict(sys.modules, {"psycopg": fake}):
            with automation.SQL(secrets).connection(app, "source"):
                pass
        self.assertEqual(seen["connect_timeout"], automation.CONNECT_TIMEOUT)

    def test_the_subscription_reconnects_with_the_same_patience(self):
        dsn = replication_tls.validate_dsn("host=10.189.0.6 port=5432 dbname=appdb user=cnp_replication password=x sslmode=require",
                                           'postgres:{"database":"appdb"}', acknowledge_wireguard_subscriber_trust=True)
        self.assertIn("connect_timeout=20", dsn)
