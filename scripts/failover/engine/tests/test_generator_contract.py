"""Contrat générateur ↔ worker : ce que le générateur écrit dans la table est exactement ce que le worker accepte.

Les deux vivent dans engine/ depuis le 08/11/2026 : ce contrat est toujours vérifié (il était ignoré sans config-repo voisin).
"""
import json
from pathlib import Path
import sys
import unittest

HERE = Path(__file__).resolve()

sys.path.insert(0, str(HERE.parents[1]))
sys.path.insert(0, str(HERE.parent))
import automation as a
import render_worker_phase1 as worker
import test_worker_phase1 as fixtures


class GeneratorContractTests(unittest.TestCase):
    def test_names_are_the_ones_the_worker_checks(self):
        self.assertEqual(worker.CONFIG_TABLE, a.PLATFORM["config_table"])
        self.assertEqual(worker.ALARM_PREFIX, a.PLATFORM["alarm_prefix"])

    def test_the_generated_configuration_is_accepted_by_the_worker(self):
        application = fixtures.application()
        self.assertEqual(a.validate({"applications": [application]}, a.PLATFORM["alarm_prefix"], a.PLATFORM["max_apps"], 0), [application])

    def test_the_stored_record_gives_the_worker_the_same_hash_as_the_generated_configuration(self):
        application = fixtures.application()
        item = json.loads(worker.config_item(application)["spec"]["forProvider"]["item"])
        stored = json.loads(item["config"]["S"])
        self.assertEqual(a.config_hash(a.normalize(stored)), a.config_hash(a.normalize(application)))

    def test_secrets_created_by_the_api_feed_the_generators_like_the_old_terraform_outputs(self):
        import platform_secrets
        from test_platform_secrets import Clients
        import prepare_failover_phase1 as prepare
        profile = fixtures.platform_profile()
        clients = Clients()
        result = platform_secrets.initialize(prepare.platform_secrets_profile(profile), clients.kube, clients.aws, clients.gsm)
        self.assertEqual(prepare.credentials_profile(profile, result["credentials"])["aws_secret_arns"], result["credentials"]["aws_secret_arns"]["value"])
        prepare.resolve_credentials(profile, result["credentials"], result["secrets"])
        application = prepare.automation_profile(profile, fixtures.observations(), result["credentials"], result["secrets"])["worker-config.json"]["applications"][0]
        self.assertEqual(application["target"]["secret_arn"], result["credentials"]["aws_secret_arns"]["value"]["target-admin"])
        a.validate({"applications": [application]}, a.PLATFORM["alarm_prefix"], a.PLATFORM["max_apps"], 0)

    def test_the_alarm_name_is_the_one_the_worker_expects_for_that_application(self):
        application = fixtures.application()
        self.assertEqual(worker.alarm(application)["metadata"]["name"], a.PLATFORM["alarm_prefix"] + application["app"])


if __name__ == "__main__":
    unittest.main()
