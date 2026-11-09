import importlib.util
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("renderer", Path(__file__).parents[1] / "render_aws_prod_example.py")
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def profile():
    # Fixtures exclusivement locales : ni cette image, ni ce secret ne sont déployés.
    return {"app_name": "fixture-example", "environment": "prod", "image":
            f"{renderer.ACCOUNT}.dkr.ecr.eu-west-3.amazonaws.com/fixture-example@sha256:" + "a" * 64,
            "database_security_group_id": "sg-0123456789abcdef0", "database_name": "appdb",
            "runtime_user": "cnp_runtime", "runtime_secret_arn":
            f"arn:aws:secretsmanager:eu-west-3:{renderer.ACCOUNT}:secret:cnp/failover/fixture-example/runtime-AbCdEf",
            "listener_priority": 321, "application_profile": "postgres", "sql_contract": {"database": "appdb"},
            "database_ca_pem": (Path(__file__).parent / "fixtures/public-test-ca.pem").read_text(),
            "master_password_secret": "cnp-fixture-example-sql"}


def observation():
    return {"kind": "Instance", "metadata": {"name": "fixture-example-prod-db"},
            "spec": {"forProvider": {"publiclyAccessible": False}},
            "status": {"conditions": [{"type": "Ready", "status": "True"}, {"type": "Synced", "status": "True"}],
                       "atProvider": {"arn": f"arn:aws:rds:eu-west-3:{renderer.ACCOUNT}:db:fixture-example-prod-db",
                                      "address": "fixture-not-deployed.abcdefgh.eu-west-3.rds.amazonaws.com",
                                      "dbName": "appdb", "publiclyAccessible": False,
                                      "masterUserSecret": [{"secretArn":
                                          f"arn:aws:secretsmanager:eu-west-3:{renderer.ACCOUNT}:secret:rds!db-fixture-AbCdEf"}]}}}


class AwsExampleTests(unittest.TestCase):
    def test_backup_retention_is_explicit_and_never_disables_backups(self):
        p = profile()
        self.assertEqual(renderer.bootstrap(p)['rds-instance.yaml']['spec']['forProvider']['backupRetentionPeriod'], 7)
        p['backup_retention_period'] = 1
        self.assertEqual(renderer.bootstrap(p)['rds-instance.yaml']['spec']['forProvider']['backupRetentionPeriod'], 1)
        for invalid in [0, -1, 36, True, '1']:
            p['backup_retention_period'] = invalid
            with self.assertRaises(ValueError):
                renderer.bootstrap(p)

    def test_bootstrap_has_parameter_group_and_private_database(self):
        files = renderer.bootstrap(profile())
        self.assertEqual(len(files), 3)
        self.assertEqual(files["rds-parameter-group.yaml"]["spec"]["forProvider"]["parameter"],
                         [{"name": "rds.logical_replication", "value": "1", "applyMethod": "pending-reboot"}])
        db = files["rds-instance.yaml"]["spec"]
        self.assertFalse(db["forProvider"]["publiclyAccessible"])
        self.assertTrue(db["forProvider"]["deletionProtection"])
        self.assertEqual(db["deletionPolicy"], "Orphan")

    def test_dev_is_rejected(self):
        p = profile(); p["environment"] = "dev"
        with self.assertRaises(ValueError): renderer.bootstrap(p)

    def test_incomplete_example_is_rejected(self):
        p = profile(); p["database_security_group_id"] = None
        with self.assertRaises(ValueError): renderer.bootstrap(p)

    def test_runtime_uses_observed_endpoint_and_own_secret(self):
        p, observed = profile(), observation()
        files = renderer.runtime(p, observed)
        container = json.loads(files["ecs-task-definition.yaml"]["spec"]["forProvider"]["containerDefinitions"])[0]
        env = {x["name"]: x["value"] for x in container["environment"]}
        self.assertEqual(env["DB_HOST"], observed["status"]["atProvider"]["address"])
        self.assertEqual(env["DB_USER"], "cnp_runtime")
        self.assertEqual(container["secrets"][0]["valueFrom"], p["runtime_secret_arn"] + ":password::")
        self.assertNotIn("logConfiguration", container)
        self.assertNotIn("562346647831", json.dumps(files))

    def test_unready_database_is_rejected(self):
        observed = observation(); observed["status"]["conditions"][0]["status"] = "False"
        with self.assertRaises(ValueError): renderer.runtime(profile(), observed)

    def test_wrong_application_is_rejected(self):
        observed = observation(); observed["metadata"]["name"] = "another-prod-db"
        with self.assertRaises(ValueError): renderer.runtime(profile(), observed)

    def test_old_account_image_is_rejected(self):
        p = profile(); p["image"] = p["image"].replace(renderer.ACCOUNT, "562346647831")
        with self.assertRaises(ValueError): renderer.runtime(p, observation())

    def test_old_account_secret_is_rejected(self):
        p = profile(); p["runtime_secret_arn"] = p["runtime_secret_arn"].replace(renderer.ACCOUNT, "562346647831")
        with self.assertRaises(ValueError): renderer.runtime(p, observation())

    def test_mutable_image_tag_is_rejected(self):
        p = profile(); p["image"] = p["image"].split("@")[0] + ":latest"
        with self.assertRaises(ValueError): renderer.runtime(p, observation())

    def test_wrong_account_database_is_rejected(self):
        observed = observation()
        observed["status"]["atProvider"]["arn"] = observed["status"]["atProvider"]["arn"].replace(renderer.ACCOUNT, "562346647831")
        with self.assertRaises(ValueError): renderer.runtime(profile(), observed)

    def test_public_database_is_rejected(self):
        for source in ["spec", "status"]:
            observed = observation()
            observed[source]["forProvider" if source == "spec" else "atProvider"]["publiclyAccessible"] = True
            with self.assertRaises(ValueError): renderer.runtime(profile(), observed)

    def test_master_secret_and_user_are_rejected(self):
        p, observed = profile(), observation()
        p["runtime_secret_arn"] = observed["status"]["atProvider"]["masterUserSecret"][0]["secretArn"]
        with self.assertRaises(ValueError): renderer.runtime(p, observed)
        p = profile(); p["runtime_user"] = "postgres"
        with self.assertRaises(ValueError): renderer.runtime(p, observed)

    def test_plain_password_field_is_rejected(self):
        p = profile(); p["password"] = "fixture-password-not-a-real-secret"
        with self.assertRaises(ValueError): renderer.runtime(p, observation())

    def test_master_secret_is_rejected_when_observation_omits_it(self):
        p, observed = profile(), observation()
        p["runtime_secret_arn"] = observed["status"]["atProvider"]["masterUserSecret"][0]["secretArn"]
        del observed["status"]["atProvider"]["masterUserSecret"]
        with self.assertRaises(ValueError): renderer.runtime(p, observed)

    def test_task_changes_when_endpoint_changes(self):
        before = renderer.runtime(profile(), observation())["ecs-task-definition.yaml"]["metadata"]["name"]
        observed = observation(); observed["status"]["atProvider"]["address"] = "fixture-new.abcdefgh.eu-west-3.rds.amazonaws.com"
        after = renderer.runtime(profile(), observed)["ecs-task-definition.yaml"]["metadata"]["name"]
        self.assertNotEqual(before, after)

    def test_https_rule_and_scoped_selector(self):
        files = renderer.runtime(profile(), observation())
        rule = files["alb-listener-rule.yaml"]["spec"]["forProvider"]
        self.assertEqual(rule["listenerArn"], renderer.PLATFORM["https_listener"])
        self.assertEqual(rule["action"][0]["targetGroupArnSelector"]["matchLabels"]["cnp.io/environment"], "prod")
        self.assertEqual(files["alb-target-group.yaml"]["spec"]["forProvider"]["healthCheck"][0]["path"], "/healthz")      # PostgreSQL : vivacité, pas la base

    def test_log_group_is_not_created_implicitly(self):
        p = profile(); p["log_group_name"] = "/ecs/fixture-existing"
        task = renderer.runtime(p, observation())["ecs-task-definition.yaml"]
        container = json.loads(task["spec"]["forProvider"]["containerDefinitions"])[0]
        self.assertNotIn("awslogs-create-group", container["logConfiguration"]["options"])

    def test_existing_output_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp); (folder / "sentinel").write_text("preserve")
            with self.assertRaises(ValueError): renderer.write_files(renderer.bootstrap(profile()), folder)
            self.assertEqual((folder / "sentinel").read_text(), "preserve")

    def test_render_has_exact_kustomization_resources(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp) / "render"
            files = renderer.runtime(profile(), observation());renderer.write_files(files, folder)
            self.assertEqual(json.loads((folder / "kustomization.yaml").read_text())["resources"], sorted(files))


if __name__ == "__main__":
    unittest.main()
