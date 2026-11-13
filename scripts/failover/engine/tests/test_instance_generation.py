"""Génération du nom Cloud SQL : Google bloque le nom d'une instance supprimée environ une semaine.

Le portail suffixe donc le nom chez Google par une génération ; le nom Kubernetes reste stable (observations, parcours).
"""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render_failover_phase1 as gcp
import test_failover_phase1


def config(generation=None):
    value = test_failover_phase1.Phase1Tests().cloudrun_profile()
    value.pop("gcp_runtime", None)
    if generation:
        value["database_instance"] = f"{value['app_name']}-prod-gcp-db-{generation}"
    return value


class GenerationTests(unittest.TestCase):
    def test_the_google_name_carries_the_generation_and_the_kubernetes_name_stays(self):
        files = gcp.cloudsql(config("m1x2y3"))
        instance = files["cloudsql-instance.yaml"]
        app = config()["app_name"]
        self.assertEqual(instance["metadata"]["name"], app + "-prod-gcp-db")
        self.assertEqual(instance["metadata"]["annotations"]["crossplane.io/external-name"], app + "-prod-gcp-db-m1x2y3")
        for name in ("cloudsql-database.yaml", "cnp_runtime.yaml", "cnp_replication.yaml"):
            self.assertEqual(files[name]["spec"]["forProvider"]["instanceRef"], {"name": app + "-prod-gcp-db"})

    def test_without_generation_nothing_changes_for_existing_applications(self):
        instance = gcp.cloudsql(config())["cloudsql-instance.yaml"]
        self.assertNotIn("crossplane.io/external-name", instance["metadata"]["annotations"])

    def test_the_observation_checks_the_google_name(self):
        value = config("m1x2y3")
        app = value["app_name"]
        observed = {"kind": "DatabaseInstance", "metadata": {"name": app + "-prod-gcp-db"},
                    "status": {"conditions": [{"type": "Ready", "status": "True"}, {"type": "Synced", "status": "True"}],
                               "atProvider": {"connectionName": f"{gcp.PROJECT}:europe-west9:{app}-prod-gcp-db-m1x2y3", "privateIpAddress": "10.189.0.6"}}}
        self.assertEqual(gcp.observed_endpoint(value, observed), "10.189.0.6")
        wrong = deepcopy(observed)
        wrong["status"]["atProvider"]["connectionName"] = f"{gcp.PROJECT}:europe-west9:{app}-prod-gcp-db"
        with self.assertRaises(ValueError):
            gcp.observed_endpoint(value, wrong)

    def test_a_foreign_or_malformed_instance_name_is_refused(self):
        for bad in ("other-prod-gcp-db-x1", "{app}-prod-gcp-db-", "{app}-prod-gcp-db-UPPER", "{app}-prod-gcp-db-x1/../y"):
            value = config()
            value["database_instance"] = bad.format(app=value["app_name"])
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                gcp.validate(value)


if __name__ == "__main__":
    unittest.main()
