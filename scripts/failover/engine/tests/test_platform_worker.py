"""Worker en mode plateforme : configuration lue dans une table, noms stricts, garde de configuration.

Aucun appel cloud. Le comportement réel de DynamoDB (conditions, transactions, pagination) est vérifié à part :
python tests/run_docker_dynamodb.py
"""
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation as a


def app(name="weather-api", prefix=None):
    return {"app": name, "profile": "postgres:{\"database\":\"appdb\"}", "hostname": f"{name}.apps.mooroon5.fr",
        "gcp_lb_ip": "34.160.1.1", "alarm_name": (prefix or a.PLATFORM["alarm_prefix"]) + name,
        "health_check_id": "12345678-1234-1234-1234-123456789abc",
        "routing_latch_id": "12345678-1234-1234-1234-123456789abd",
        "primary_health_check_id": "12345678-1234-1234-1234-123456789abe",
        "source": {"host": "10.189.0.3", "ca_pem": "TEST-CA",
            "secret_arn": f"arn:aws:secretsmanager:eu-west-3:626278345026:secret:cnp/failover/{name}/source-admin-AbCd12"},
        "target": {"host": f"{name}-prod-db.abcdef.eu-west-3.rds.amazonaws.com", "ca_pem": "TEST-CA",
            "secret_arn": f"arn:aws:secretsmanager:eu-west-3:626278345026:secret:cnp/failover/{name}/target-admin-AbCd12"}}


def row(application, name=None):
    return {"app": {"S": name or application["app"]}, "config": {"S": json.dumps(application)}}


# Préfixe d'alarme du worker historique du pilote, retiré le 07/11/2026.
OLD_PREFIX = "cnp-failover-"

class FakeScanClient:
    """Pagination de Scan : le jeton de reprise est l'indice du premier élément de la page suivante."""
    def __init__(self, items):
        self.items, self.calls = items, 0

    def scan(self, **args):
        self.calls += 1
        start = int(args.get("ExclusiveStartKey", {}).get("i", 0))
        size = args.get("Limit") or len(self.items)
        page = self.items[start:start + size]
        more = start + size < len(self.items)
        return {"Items": page, **({"LastEvaluatedKey": {"i": start + size}} if more else {})}


@patch.object(a.ssl, "create_default_context")
class ValidationTests(unittest.TestCase):
    def test_platform_alarm_prefix_never_overlaps_the_pilot_alarm(self, _):
        # Une règle EventBridge sur le préfixe plateforme ne doit jamais capter l'alarme du pilote.
        self.assertFalse("cnp-failover-app4-pixelcam".startswith(a.PLATFORM["alarm_prefix"]))
        a.validate_application(app(), a.PLATFORM["alarm_prefix"])
        with self.assertRaises(a.Blocked):
            a.validate_application(app(prefix=OLD_PREFIX), a.PLATFORM["alarm_prefix"])
        with self.assertRaises(a.Blocked):
            a.validate_application(app(), OLD_PREFIX)

    def test_platform_has_no_limit_of_ten_apps_and_accepts_none(self, _):
        names = [f"app-{index:03d}" for index in range(200)]
        self.assertEqual(len(a.validate({"applications": [app(name) for name in names]}, a.PLATFORM["alarm_prefix"], 200)), 200)
        with self.assertRaises(a.Blocked):
            a.validate({"applications": [app(f"app-{index:03d}") for index in range(201)]}, a.PLATFORM["alarm_prefix"], 200)
        self.assertEqual(a.validate({"applications": []}, a.PLATFORM["alarm_prefix"], 200, minimum=0), [])

    def test_a_missing_and_a_null_value_give_the_same_identity(self, _):
        plain, nulled = app(), app()
        nulled["readiness_path"] = None
        self.assertEqual(a.config_hash(a.normalize(plain)), a.config_hash(a.normalize(nulled)))
        self.assertNotEqual(a.config_hash(plain), a.config_hash(app("other-api")))


@patch.object(a.ssl, "create_default_context")
class ConfigTableTests(unittest.TestCase):
    def test_every_page_is_read_and_applications_are_sorted(self, _):
        client = FakeScanClient([row(app(name)) for name in ("zeta-api", "alpha-api", "mid-api", "beta-api", "gamma-api")])
        apps, invalid = a.ConfigTable(client, "table", page_size=2).applications()
        self.assertEqual([value["app"] for value in apps], ["alpha-api", "beta-api", "gamma-api", "mid-api", "zeta-api"])
        self.assertEqual((invalid, client.calls), ([], 3))

    def test_one_invalid_configuration_never_removes_the_others(self, _):
        legacy_alarm = app("old-alarm", OLD_PREFIX)
        public_sql = app("public-sql")
        public_sql["source"]["host"] = "8.8.8.8"
        items = [row(app("good-one")), row(app("good-two")), {"app": {"S": "bad-json"}, "config": {"S": "{not json"}},
                 row(app("mismatch"), name="other-name"), row(legacy_alarm), row(public_sql), {"app": {"S": "no-config"}},
                 {"app": {"S": "bad-type"}, "config": {"N": "1"}}]
        apps, invalid = a.ConfigTable(FakeScanClient(items), "table").applications()
        self.assertEqual([value["app"] for value in apps], ["good-one", "good-two"])
        self.assertEqual(invalid, sorted(["bad-json", "other-name", "old-alarm", "public-sql", "no-config", "bad-type"]))

    def test_an_empty_table_means_no_application_not_an_error(self, _):
        self.assertEqual(a.ConfigTable(FakeScanClient([]), "table").applications(), ([], []))

    def test_null_values_written_by_another_tool_do_not_change_the_identity(self, _):
        written = app()
        written["readiness_path"] = None
        apps, _invalid = a.ConfigTable(FakeScanClient([row(written)]), "table").applications()
        self.assertEqual(a.config_hash(apps[0]), a.config_hash(a.normalize(app())))


class ChangedConfigurationTests(unittest.TestCase):
    def worker(self, control):
        store = Mock()
        store.control.return_value = control
        return a.Worker(store, Mock(), Mock(), Mock()), store

    def test_a_configuration_changed_since_it_was_verified_blocks_and_alerts(self):
        worker, store = self.worker({"config_hash": "hash-of-the-verified-configuration", "state": "WAIT_SIGNALS"})
        self.assertEqual(worker.run(app()), "BLOCKED_CONFIG_CHANGED")
        store.report_config_change.assert_called_once()
        store.acquire.assert_not_called()                   # aucune action, aucune prise de bail
        worker.signals.assert_not_called()

    def test_the_verified_configuration_proceeds_to_the_lease(self):
        worker, store = self.worker({"config_hash": a.config_hash(app())})
        store.acquire.return_value = False
        self.assertEqual(worker.run(app()), "PAUSED_UNCONFIGURED_OR_BUSY")
        store.report_config_change.assert_not_called()

    def test_an_application_never_configured_keeps_the_previous_answer(self):
        worker, store = self.worker({})
        store.acquire.return_value = False
        self.assertEqual(worker.run(app()), "PAUSED_UNCONFIGURED_OR_BUSY")
        store.report_config_change.assert_not_called()


class RegimeTests(unittest.TestCase):
    def components(self, environ):
        with patch.dict(os.environ, environ, clear=False):
            return a.aws_components(lambda service, region=a.REGION: Mock())

    PLATFORM_ENV = {"CNP_CONFIG_TABLE": a.PLATFORM["config_table"], "CNP_STATE_TABLE": a.PLATFORM["state_table"],
        "CNP_NOTIFICATION_TOPIC": f"arn:aws:sns:{a.REGION}:{a.ACCOUNT}:{a.PLATFORM['topic']}"}
    # Noms du worker historique du pilote (retiré le 07/11/2026) : refusés.
    LEGACY_ENV = {"CNP_STATE_TABLE": "cnp-failover-automation",
        "CNP_NOTIFICATION_TOPIC": f"arn:aws:sns:{a.REGION}:{a.ACCOUNT}:cnp-failover-automation"}

    def setUp(self):
        for key in ("CNP_CONFIG_TABLE", "CNP_STATE_TABLE", "CNP_NOTIFICATION_TOPIC"):
            patcher = patch.dict(os.environ)
            patcher.start()
            self.addCleanup(patcher.stop)
            os.environ.pop(key, None)

    def test_each_regime_accepts_only_its_own_names(self):
        self.assertEqual(len(self.components(self.PLATFORM_ENV)), 4)
        with self.assertRaises(a.Blocked):                  # le régime historique du pilote n'existe plus
            self.components(self.LEGACY_ENV)
        with self.assertRaises(a.Blocked):                  # nouvelle table de config avec les noms du pilote
            self.components({**self.LEGACY_ENV, "CNP_CONFIG_TABLE": a.PLATFORM["config_table"]})
        with self.assertRaises(a.Blocked):                  # noms de la plateforme sans table de config
            self.components(self.PLATFORM_ENV | {"CNP_CONFIG_TABLE": ""})
        with self.assertRaises(a.Blocked):
            self.components({**self.PLATFORM_ENV, "CNP_NOTIFICATION_TOPIC": self.LEGACY_ENV["CNP_NOTIFICATION_TOPIC"]})

    def test_the_configuration_table_name_is_checked(self):
        with patch.dict(os.environ, {"CNP_CONFIG_TABLE": "another-table"}), self.assertRaises(a.Blocked):
            a.platform_config(lambda service, region=a.REGION: Mock())
        with patch.dict(os.environ, {"CNP_CONFIG_TABLE": a.PLATFORM["config_table"]}):
            self.assertEqual(a.platform_config(lambda service, region=a.REGION: Mock()).table, a.PLATFORM["config_table"])


class MainTests(unittest.TestCase):
    def run_main(self, argv, **patches):
        out = io.StringIO()
        names = {"CNP_CONFIG_TABLE": a.PLATFORM["config_table"], "CNP_STATE_TABLE": a.PLATFORM["state_table"],
            "CNP_NOTIFICATION_TOPIC": f"arn:aws:sns:{a.REGION}:{a.ACCOUNT}:{a.PLATFORM['topic']}"}
        with patch.dict(os.environ, names), patch("sys.stdout", out):
            code = a.main(argv)
        return code, out.getvalue()

    def test_simulation_never_reaches_aws_nor_the_table(self):
        with patch.object(a, "aws_session") as session:
            code, output = self.run_main(["run"])
            self.assertEqual(code, 0)
            self.assertFalse(json.loads(output)["cloud_called"])
            session.assert_not_called()
            self.assertEqual(self.run_main(["status", "--app", "weather-api"])[0], 0)

    def test_a_write_operation_needs_an_explicit_application(self):
        with patch.object(a, "aws_session"), patch("sys.stderr", io.StringIO()):
            for operation in ("configure", "pause", "resume"):
                self.assertEqual(self.run_main([operation, "--execute"])[0], 1)

    @patch.object(a.ssl, "create_default_context")
    def test_an_invalid_application_is_reported_and_the_others_still_run(self, _):
        worker = Mock()
        worker.run.return_value = "WAIT_SIGNALS"
        store = Mock()
        source = Mock()
        source.applications.return_value = ([app("good-one"), app("good-two")], ["broken-api"])
        with patch.object(a, "aws_session", return_value=Mock()), patch.object(a, "platform_config", return_value=source), \
                patch.object(a, "aws_components", return_value=(store, Mock(), Mock(), Mock())), patch.object(a, "Worker", return_value=worker):
            code, output = self.run_main(["run", "--execute"])
        self.assertEqual(code, 1)                           # l'erreur de configuration reste visible
        self.assertIn('"broken-api", "state": "BLOCKED_INVALID_CONFIG"', output.replace('{"app": ', ''))
        self.assertEqual(worker.run.call_count, 2)           # les deux apps valides ont bien été traitées
        self.assertEqual(store.notify_pending.call_count, 2)

    def test_wrong_names_are_refused_before_any_aws_session(self):
        good = {"CNP_CONFIG_TABLE": a.PLATFORM["config_table"], "CNP_STATE_TABLE": a.PLATFORM["state_table"],
            "CNP_NOTIFICATION_TOPIC": f"arn:aws:sns:{a.REGION}:{a.ACCOUNT}:{a.PLATFORM['topic']}"}
        for wrong in ({"CNP_CONFIG_TABLE": "another-table"}, {"CNP_STATE_TABLE": "cnp-failover-automation"},
                      {"CNP_NOTIFICATION_TOPIC": f"arn:aws:sns:{a.REGION}:{a.ACCOUNT}:cnp-failover-automation"}):
            with self.subTest(wrong=wrong), patch.dict(os.environ, {**good, **wrong}), patch.object(a, "aws_session") as session, \
                    patch("sys.stdout", io.StringIO()), patch("sys.stderr", io.StringIO()):
                self.assertEqual(a.main(["run", "--execute"]), 1)
                session.assert_not_called()

    @patch.object(a.ssl, "create_default_context")
    def test_no_application_configured_means_nothing_to_do(self, _):
        source = Mock()
        source.applications.return_value = ([], [])
        with patch.object(a, "aws_session", return_value=Mock()), patch.object(a, "platform_config", return_value=source), \
                patch.object(a, "aws_components", return_value=(Mock(), Mock(), Mock(), Mock())), patch.object(a, "Worker") as worker:
            code, _output = self.run_main(["run", "--execute"])
        self.assertEqual(code, 0)
        worker.assert_not_called()

    @patch.object(a.ssl, "create_default_context")
    def test_an_unknown_application_is_refused(self, _):
        source = Mock()
        source.applications.return_value = ([app("good-one")], [])
        with patch.object(a, "aws_session", return_value=Mock()), patch.object(a, "platform_config", return_value=source), \
                patch.object(a, "aws_components", return_value=(Mock(), Mock(), Mock(), Mock())), patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.run_main(["status", "--app", "missing-api", "--execute"])[0], 1)


if __name__ == "__main__":
    unittest.main()
