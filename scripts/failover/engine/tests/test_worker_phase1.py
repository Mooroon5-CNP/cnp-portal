"""Étape « worker » : alarme et configuration de l'app pour le worker de bascule, publiées par GitOps.

Le régime « plateforme » (automation.regime) remplace la pile Terraform par app : l'alarme et l'enregistrement de configuration deviennent des
ressources Crossplane de l'app, et le mot de passe administrateur de RDS est le nôtre (Secret Kubernetes), plus celui géré par RDS.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_failover_phase1 as prepare
import render_aws_prod_example as aws
import render_worker_phase1 as worker
import crd_schema
from test_phase1_package import profile, observations, outputs, secret_result, kustomization


def legacy_profile():
    """Profil de l'ancien régime du pilote (sans « regime ») : refusé partout depuis le 07/11/2026."""
    value = profile()
    del value["automation"]["regime"]
    return value


def platform_profile():
    value = profile()
    value["automation"]["regime"] = "platform"
    value["automation"].update(prepare.PLATFORM_TASKS)
    value["gcp"]["credentials_secret_name"] = f"cnp-{value['gcp']['app_name']}-sql"
    value["aws"]["master_password_secret"] = value["gcp"]["credentials_secret_name"]
    return value


def platform_outputs():
    value = outputs()
    app = profile()["gcp"]["app_name"]
    value["aws_secret_arns"]["value"]["target-admin"] = f"arn:aws:secretsmanager:eu-west-3:804210702561:secret:cnp/failover/{app}/target-admin-AbCd12"
    return value


def application():
    return prepare.automation_profile(platform_profile(), observations(), platform_outputs(), secret_result())["worker-config.json"]["applications"][0]


class ManifestTests(unittest.TestCase):
    def test_the_alarm_mirrors_what_terraform_used_to_create(self):
        value = application()
        alarm = worker.alarm(value)
        self.assertEqual(alarm["metadata"]["name"], value["alarm_name"])
        self.assertEqual(alarm["metadata"]["annotations"]["crossplane.io/external-name"], value["alarm_name"])
        self.assertTrue(value["alarm_name"].startswith("cnp-failover-platform-"))
        self.assertEqual(alarm["spec"]["forProvider"], {
            "region": "us-east-1", "namespace": "AWS/Route53", "metricName": "HealthCheckStatus",
            "dimensions": {"HealthCheckId": value["health_check_id"]}, "statistic": "Maximum", "period": 60,
            "evaluationPeriods": 1, "datapointsToAlarm": 1, "comparisonOperator": "LessThanThreshold", "threshold": 1,
            "treatMissingData": "missing"})

    def test_the_configuration_record_carries_exactly_what_the_worker_will_validate(self):
        value = application()
        record = worker.config_item(value)["spec"]["forProvider"]
        self.assertEqual((record["tableName"], record["hashKey"], record["region"]), ("cnp-failover-platform-config", "app", "eu-west-3"))
        item = json.loads(record["item"])
        self.assertEqual(set(item), {"app", "config"})
        self.assertEqual(item["app"], {"S": value["app"]})
        self.assertEqual(json.loads(item["config"]["S"]), value)            # même contenu, donc même empreinte côté worker
        self.assertNotIn("null", item["config"]["S"])

    def test_no_secret_value_is_ever_written_into_git(self):
        text = json.dumps([worker.alarm(application()), worker.config_item(application())]).lower()
        for forbidden in ("password", "secretvalue", "private key"):
            self.assertNotIn(forbidden, text)
        self.assertIn("secret:cnp/failover/", text)                           # des références (ARN), jamais des valeurs

    def test_both_resources_follow_the_official_provider_schema(self):
        value = application()
        self.assertEqual(crd_schema.manifest_problems(worker.alarm(value), "metricalarm.v1beta1.json"), [])
        self.assertEqual(crd_schema.manifest_problems(worker.config_item(value), "tableitem.v1beta1.json"), [])

    def test_the_schema_check_really_detects_a_wrong_manifest(self):
        alarm = worker.alarm(application())
        alarm["spec"]["forProvider"]["alarmName"] = "x"                       # champ qui n'existe pas : le nom est l'external-name
        alarm["spec"]["forProvider"]["period"] = "60"
        del alarm["spec"]["forProvider"]["region"]
        found = " | ".join(crd_schema.manifest_problems(alarm, "metricalarm.v1beta1.json"))
        for expected in ("alarmName : champ inconnu", "period : nombre attendu", "region : champ requis absent"):
            self.assertIn(expected, found)


class RegimeTests(unittest.TestCase):
    def test_the_platform_regime_uses_its_own_alarm_prefix_and_our_own_database_admin_secret(self):
        value = application()
        self.assertEqual(value["target"]["secret_arn"], platform_outputs()["aws_secret_arns"]["value"]["target-admin"])
        self.assertNotIn("rds!db-", json.dumps(value))                         # plus le secret géré par RDS (nom aléatoire)

    def test_the_historical_pilot_regime_is_refused(self):
        with self.assertRaises(ValueError):
            prepare.automation_profile(legacy_profile(), observations(), outputs(), secret_result())

    def test_the_platform_regime_has_no_per_application_terraform(self):
        self.assertNotIn("automation.tfvars.json", prepare.automation_profile(platform_profile(), observations(), platform_outputs(), secret_result()))

    def test_the_four_credential_containers_are_required(self):
        self.assertEqual(set(prepare.credentials_profile(platform_profile(), platform_outputs())["aws_secret_arns"]),
                         {"bootstrap", "source-admin", "runtime", "target-admin"})
        missing = outputs()
        del missing["aws_secret_arns"]["value"]["target-admin"]
        with self.assertRaises(ValueError):
            prepare.credentials_profile(platform_profile(), missing)            # le conteneur target-admin manque

    def test_rds_always_uses_our_secret(self):
        mine = aws.bootstrap(platform_profile()["aws"])["rds-instance.yaml"]["spec"]["forProvider"]
        self.assertIs(mine["manageMasterUserPassword"], False)
        self.assertEqual(mine["passwordSecretRef"], {"name": platform_profile()["gcp"]["credentials_secret_name"],
                                                     "namespace": "crossplane-system", "key": "target-admin-password"})
        without = profile()["aws"]
        del without["master_password_secret"]
        with self.assertRaises(ValueError):
            aws.bootstrap(without)                                              # plus de secret géré par RDS (pilote)

    def test_the_rds_manifest_follows_the_official_schema_in_both_regimes(self):
        for config in (platform_profile()["aws"], profile()["aws"]):
            found = crd_schema.manifest_problems(aws.bootstrap(config)["rds-instance.yaml"], "instance.v1beta2.json")
            self.assertEqual(found, [])

    def test_the_platform_regime_names_the_kubernetes_secret_after_the_application(self):
        wrong = platform_profile()
        wrong["gcp"]["credentials_secret_name"] = wrong["aws"]["master_password_secret"] = "cnp-recette-sql"
        with self.assertRaisesRegex(ValueError, "cnp-<app>-sql"):
            prepare.validate(wrong)
        prepare.validate(profile())                                           # le pilote garde son nom historique

    def test_the_platform_secrets_profile_needs_no_terraform_output(self):
        value = platform_profile()
        self.assertEqual(prepare.platform_secrets_profile(value), {"app": value["gcp"]["app_name"],
            "kubernetes_secret": value["gcp"]["credentials_secret_name"], "gcp_runtime_service_account": value["gcp"]["gcp_runtime"]["service_account"]})
        with self.assertRaises(ValueError):
            prepare.platform_secrets_profile(legacy_profile())

    def test_only_the_platform_ecs_tasks_are_accepted(self):
        wrong = platform_profile()
        wrong["automation"]["worker_task_definition"] = "cnp-failover-automation"          # le worker du pilote
        with self.assertRaises(ValueError):
            prepare.validate(wrong)

    def test_inside_the_cluster_the_platform_regime_needs_no_kubernetes_context(self):
        value = platform_profile()
        value["automation"]["kube_context"] = None
        self.assertIsNone(prepare.credentials_profile(value, platform_outputs())["kube_context"])
        value["automation"]["kube_context"] = "gke_other_project_cluster"
        with self.assertRaises(ValueError):
            prepare.credentials_profile(value, platform_outputs())               # fourni, il doit rester celui du projet

    def test_invalid_regime_or_secret_name_is_refused(self):
        wrong = platform_profile()
        wrong["automation"]["regime"] = "other"
        with self.assertRaises(ValueError):
            prepare.validate(wrong)
        for name in ("Upper", "has space", "", "x" * 300, "../escape"):
            bad = platform_profile()
            bad["aws"]["master_password_secret"] = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                aws.validate(bad["aws"])


class StageTests(unittest.TestCase):
    def build(self, **changes):
        arguments = dict(profile=platform_profile(), stage="worker", baseline=kustomization(), observations=observations(),
                         urlmap=None, credentials=platform_outputs(), secret_result=secret_result())
        arguments.update(changes)
        return prepare.build(**arguments)

    def test_the_stage_adds_only_its_two_files_and_references_them(self):
        files = self.build()
        app = profile()["gcp"]["app_name"]
        base = f"apps/{app}/crossplane/prod/"
        self.assertEqual(set(files), {base + "failover-alarm.yaml", base + "failover-config.yaml", base + "kustomization.yaml"})
        merged = files[base + "kustomization.yaml"]["resources"]
        self.assertTrue({"failover-alarm.yaml", "failover-config.yaml"} <= set(merged))
        self.assertTrue(set(kustomization()["resources"]) <= set(merged))      # les ressources existantes restent référencées

    def test_a_profile_without_regime_has_no_such_stage(self):
        with self.assertRaises(ValueError):
            self.build(profile=legacy_profile(), credentials=outputs())

    def test_an_unready_health_check_cannot_produce_an_alarm(self):
        broken = observations()
        broken["healthcheck"]["status"]["conditions"][0]["status"] = "False"
        with self.assertRaises(ValueError):
            self.build(observations=broken)

    def test_the_alarm_follows_the_real_health_check_not_a_guess(self):
        files = self.build()
        alarm = next(value for name, value in files.items() if name.endswith("failover-alarm.yaml"))
        self.assertEqual(alarm["spec"]["forProvider"]["dimensions"]["HealthCheckId"], observations()["healthcheck"]["status"]["atProvider"]["id"])

    def test_the_stage_is_a_choice_of_the_command_line(self):
        self.assertIn("worker", prepare.STAGES)


if __name__ == "__main__":
    unittest.main()
