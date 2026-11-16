"""Secrets du régime plateforme : Secret Kubernetes d'origine, copies AWS et GCP, sans CLI.

Les faux clients reproduisent les codes d'erreur réels. Les adaptateurs sont testés contre les vraies classes des bibliothèques
(`create_autospec`) et les requêtes envoyées sont reconstruites avec les vrais types de requête : un nom de champ faux échoue ici.
Bibliothèques nécessaires pour ces derniers tests : kubernetes, google-cloud-secret-manager (ignorés sinon).
"""
import base64
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import create_autospec

from botocore.exceptions import ClientError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bootstrap
import platform_secrets as ps

APP = "weather-api"
SA = "cnp-runtime@cnp-terraform-512313.iam.gserviceaccount.com"
CONFIG = {"app": APP, "kubernetes_secret": f"cnp-{APP}-sql", "gcp_runtime_service_account": SA}


def error(code):
    return ClientError({"Error": {"Code": code, "Message": "fake"}}, "op")


class FakeKube:
    def __init__(self):
        self.secrets, self.creates, self.race = {}, 0, None

    def get(self, name):
        return deepcopy(self.secrets.get(name))

    def create(self, manifest):
        self.creates += 1
        if self.race:                                   # un autre opérateur crée le Secret juste avant nous
            self.secrets[manifest["metadata"]["name"]], self.race = self.race, None
        name = manifest["metadata"]["name"]
        if name in self.secrets:
            raise ps.Exists()
        self.secrets[name] = deepcopy(manifest)

    def delete(self, name):
        self.secrets.pop(name, None)


class FakeAWS:
    def __init__(self):
        self.secrets, self.writes, self.lose_response = {}, 0, False

    def find(self, key):
        return next((value for name, value in self.secrets.items() if key in (name, value["ARN"])), None)

    def describe_secret(self, SecretId):
        found = self.find(SecretId)
        if not found:
            raise error("ResourceNotFoundException")
        meta = {"ARN": found["ARN"], "Tags": found["Tags"]}
        if found.get("DeletedDate"):
            meta["DeletedDate"] = found["DeletedDate"]
        if found.get("value") is not None:
            meta["VersionIdsToStages"] = {"v1": ["AWSCURRENT"]}
        return meta

    def create_secret(self, Name, SecretString, ClientRequestToken, Tags):
        if Name in self.secrets:
            raise error("ResourceExistsException")
        self.writes += 1
        self.secrets[Name] = {"ARN": f"arn:aws:secretsmanager:eu-west-3:626278345026:secret:{Name}-AbCd12", "Tags": Tags, "value": SecretString}
        if self.lose_response:
            raise error("RequestTimeout")
        return {"ARN": self.secrets[Name]["ARN"]}

    def get_secret_value(self, SecretId):
        found = self.find(SecretId)
        if not found or found.get("value") is None:
            raise error("ResourceNotFoundException")
        return {"SecretString": found["value"]}

    def delete_secret(self, SecretId, ForceDeleteWithoutRecovery):
        assert ForceDeleteWithoutRecovery is True
        self.deleted = getattr(self, 'deleted', []) + [SecretId]
        del self.secrets[next(name for name, value in self.secrets.items() if SecretId in (name, value['ARN']))]

    def put_secret_value(self, SecretId, ClientRequestToken, SecretString):
        self.writes += 1
        self.find(SecretId)["value"] = SecretString


class FakeGSM:
    def __init__(self):
        self.secrets, self.policy, self.writes = {}, {"bindings": [], "etag": b"e1"}, []

    def get_secret(self, name):
        return deepcopy(self.secrets[name]["meta"]) if name in self.secrets else None

    def create_secret(self, parent, secret_id, labels, location):
        name = f"{parent}/secrets/{secret_id}"
        if name in self.secrets:
            raise ps.Exists()
        self.writes.append(("create", location))
        self.secrets[name] = {"meta": {"labels": labels}, "versions": []}

    def list_versions(self, name):
        return [{"name": v["name"], "state": v["state"]} for v in self.secrets[name]["versions"]]

    def access(self, version):
        secret = version.rsplit("/versions/", 1)[0]
        return next(v["data"] for v in self.secrets[secret]["versions"] if v["name"] == version)

    def add_version(self, name, text):
        self.writes.append(("version",))
        version = f"{name}/versions/{len(self.secrets[name]['versions']) + 1}"
        self.secrets[name]["versions"].append({"name": version, "state": "ENABLED", "data": text})
        return version

    def get_policy(self, name):
        return deepcopy(self.policy)

    def delete_secret(self, name):
        self.secrets.pop(name)

    def set_policy(self, name, policy):
        self.writes.append(("policy", policy["etag"]))
        self.policy = {"bindings": policy["bindings"], "etag": b"e2"}


class Clients:
    def __init__(self):
        self.kube, self.aws, self.gsm = FakeKube(), FakeAWS(), FakeGSM()

    def run(self, config=CONFIG):
        return ps.initialize(config, self.kube, self.aws, self.gsm)

    def values(self):
        data = self.kube.secrets[CONFIG["kubernetes_secret"]]["data"]
        return {key: base64.b64decode(value).decode() for key, value in data.items()}

    def aws_value(self, role):
        return json.loads(self.aws.secrets[f"cnp/failover/{APP}/{role}"]["value"])


GCP_NAME = f"projects/cnp-terraform-512313/secrets/{APP}-prod-runtime"


class FirstRunTests(unittest.TestCase):
    def setUp(self):
        self.clients = Clients()
        self.result = self.clients.run()

    def test_the_kubernetes_secret_is_the_origin_of_every_value(self):
        secret = self.clients.kube.secrets[f"cnp-{APP}-sql"]
        self.assertEqual(secret["metadata"]["namespace"], "crossplane-system")
        self.assertEqual(secret["metadata"]["labels"]["cnp.io/credentials"], "platform")
        values = self.clients.values()
        self.assertEqual(set(values), set(ps.KEYS))
        self.assertEqual(len(set(values.values())), 5)                        # cinq mots de passe distincts
        self.assertTrue(all(len(value) >= 48 for value in values.values()))
        self.assertIn("target-admin-password", values)                       # la clé que lit RDS (L3)

    def test_aws_copies_have_the_formats_their_readers_expect(self):
        values = self.clients.values()
        self.assertEqual(self.clients.aws_value("target-admin"), {"username": "cnp_owner", "password": values["target-admin-password"]})
        self.assertEqual(self.clients.aws_value("source-admin"), {"username": "postgres", "password": values["admin-password"]})
        self.assertEqual(self.clients.aws_value("runtime"), {"username": "cnp_runtime", "password": values["target-runtime-password"]})
        boot = self.clients.aws_value("bootstrap")
        self.assertEqual(set(boot), {"app", "schema_version", *ps.BOOTSTRAP_KEYS})   # identique au pilote
        self.assertNotIn("target-admin-password", boot)
        tags = {t["Key"]: t["Value"] for t in self.clients.aws.secrets[f"cnp/failover/{APP}/bootstrap"]["Tags"]}
        self.assertEqual((tags["Application"], tags["ManagedBy"]), (APP, "cnp-platform"))

    def test_the_bootstrap_task_accepts_the_bootstrap_copy(self):
        class Reader:
            def get_secret_value(_, SecretId):
                return {"SecretString": json.dumps(self.clients.aws_value("bootstrap"))}
        config = {"app": APP, "bootstrap_secret_arn": "x", "subscription_tls_mode": "wireguard-tls", "acknowledge_wireguard_subscriber_trust": True,
                  "source": {"host": "10.189.0.3"}, "profile": 'postgres:{"database":"appdb"}'}
        dsn = bootstrap.replication_dsn(config, Reader())
        self.assertIn("cnp_replication", dsn)

    def test_cloud_run_gets_the_runtime_password_and_only_its_runtime_identity_is_granted(self):
        versions = self.clients.gsm.secrets[GCP_NAME]["versions"]
        self.assertEqual([v["data"] for v in versions], [self.clients.values()["runtime-password"]])
        self.assertEqual(self.result["secrets"]["gcp_password_version"], "1")
        self.assertEqual(self.clients.gsm.policy["bindings"], [{"role": "roles/secretmanager.secretAccessor", "members": [f"serviceAccount:{SA}"]}])
        self.assertIn(("create", "europe-west9"), self.clients.gsm.writes)

    def test_the_result_has_the_shape_of_the_old_terraform_outputs_and_no_value(self):
        arns = self.result["credentials"]["aws_secret_arns"]["value"]
        self.assertEqual(set(arns), set(ps.ROLES))
        self.assertEqual(self.result["credentials"]["gcp_runtime_secret"]["value"], GCP_NAME)
        text = json.dumps(self.result)
        for value in self.clients.values().values():
            self.assertNotIn(value, text)
        self.assertIs(self.result["secrets"]["passwords_printed"], False)

    def test_a_second_run_writes_nothing_and_returns_the_same_references(self):
        writes = (self.clients.kube.creates, self.clients.aws.writes, len(self.clients.gsm.writes))
        again = self.clients.run()
        self.assertEqual(again, self.result)
        self.assertEqual((self.clients.kube.creates, self.clients.aws.writes, len(self.clients.gsm.writes)), writes)


class ExistingStateTests(unittest.TestCase):
    def test_an_existing_kubernetes_secret_is_reused_never_regenerated(self):
        clients = Clients()
        clients.run()
        before = clients.values()
        clients.aws.secrets.clear(); clients.gsm.secrets.clear()             # copies perdues : elles se refont depuis l'origine
        clients.run()
        self.assertEqual(clients.values(), before)
        self.assertEqual(clients.aws_value("target-admin")["password"], before["target-admin-password"])

    def test_a_concurrent_creation_wins_and_its_values_are_used(self):
        clients = Clients()
        other = Clients(); other.run()
        clients.kube.race = other.kube.secrets[CONFIG["kubernetes_secret"]]
        clients.run()
        self.assertEqual(clients.values(), other.values())
        self.assertEqual(clients.aws_value("bootstrap")["replication-password"], other.values()["replication-password"])

    def test_a_kubernetes_secret_from_elsewhere_stops_everything_before_any_copy(self):
        for change in ("pilot-label", "missing-key", "short"):
            clients = Clients(); clients.run()
            secret = clients.kube.secrets[CONFIG["kubernetes_secret"]]
            clients.aws.secrets.clear(); clients.gsm.secrets.clear()
            if change == "pilot-label":
                secret["metadata"]["labels"]["cnp.io/credentials"] = "phase1-bootstrap"
            elif change == "missing-key":
                del secret["data"]["target-admin-password"]
            else:
                secret["data"]["admin-password"] = base64.b64encode(b"short").decode()
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "Secret Kubernetes existant incompatible"):
                clients.run()
            self.assertEqual((clients.aws.secrets, clients.gsm.secrets), ({}, {}))

    def test_an_aws_value_that_differs_is_never_overwritten(self):
        clients = Clients(); clients.run()
        clients.aws.secrets[f"cnp/failover/{APP}/runtime"]["value"] = json.dumps({"username": "cnp_runtime", "password": "other" * 10})
        with self.assertRaisesRegex(ValueError, "aucune rotation"):
            clients.run()

    def test_an_aws_container_not_created_by_the_platform_or_being_deleted_is_refused(self):
        for change in ("terraform", "other-app", "deleted"):
            clients = Clients(); clients.run()
            item = clients.aws.secrets[f"cnp/failover/{APP}/target-admin"]
            if change == "deleted":
                item["DeletedDate"] = "2026-11-05"
            else:
                key, value = ("ManagedBy", "Terraform") if change == "terraform" else ("Application", "other")
                item["Tags"] = [t if t["Key"] != key else {"Key": key, "Value": value} for t in item["Tags"]]
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "non créé par la plateforme"):
                clients.run()

    def test_a_lost_response_after_a_successful_creation_is_not_a_failure(self):
        clients = Clients()
        clients.aws.lose_response = True
        result = clients.run()
        self.assertEqual(set(result["credentials"]["aws_secret_arns"]["value"]), set(ps.ROLES))

    def test_an_empty_aws_container_receives_its_value(self):
        clients = Clients(); clients.run()
        clients.aws.secrets[f"cnp/failover/{APP}/runtime"]["value"] = None
        clients.run()
        self.assertEqual(clients.aws_value("runtime")["password"], clients.values()["target-runtime-password"])

    def test_gcp_refuses_a_different_value_disabled_versions_and_foreign_labels(self):
        for change in ("value", "disabled", "labels"):
            clients = Clients(); clients.run()
            secret = clients.gsm.secrets[GCP_NAME]
            if change == "value":
                secret["versions"][0]["data"] = "other"
            elif change == "disabled":
                secret["versions"][0]["state"] = "DISABLED"
            else:
                secret["meta"]["labels"]["managed-by"] = "terraform"
            with self.subTest(change=change), self.assertRaises(ValueError):
                clients.run()

    def test_existing_grants_are_kept_and_the_write_is_conditioned_on_the_read(self):
        clients = Clients()
        clients.gsm.policy = {"bindings": [{"role": "roles/secretmanager.secretAccessor", "members": ["user:someone@example.test"]},
                                           {"role": "roles/secretmanager.admin", "members": ["group:admins@example.test"]}], "etag": b"e1"}
        clients.run()
        self.assertIn(("policy", b"e1"), clients.gsm.writes)
        bindings = {b["role"]: b["members"] for b in clients.gsm.policy["bindings"]}
        self.assertEqual(bindings["roles/secretmanager.secretAccessor"], ["user:someone@example.test", f"serviceAccount:{SA}"])
        self.assertEqual(bindings["roles/secretmanager.admin"], ["group:admins@example.test"])

    def test_invalid_profiles_are_refused_before_any_call(self):
        for bad in ({**CONFIG, "app": "Bad"}, {**CONFIG, "kubernetes_secret": "cnp-other-sql"},
                    {**CONFIG, "gcp_runtime_service_account": "x@other-project.iam.gserviceaccount.com"}, {**CONFIG, "extra": 1}):
            clients = Clients()
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                clients.run(bad)
            self.assertEqual((clients.kube.creates, clients.aws.writes), (0, 0))


class RemovalTests(unittest.TestCase):
    def test_removal_deletes_the_three_places_and_frees_the_names_at_once(self):
        clients = Clients(); clients.run()
        result = ps.remove(CONFIG, clients.kube, clients.aws, clients.gsm)
        self.assertEqual((clients.kube.secrets, clients.aws.secrets, clients.gsm.secrets), ({}, {}, {}))
        self.assertEqual(len(result["removed"]), 6)
        clients.run()                                                            # le même nom se recrée aussitôt
        self.assertEqual(len(clients.aws.secrets), 4)

    def test_removal_is_replayable_when_everything_is_already_gone(self):
        clients = Clients()
        self.assertEqual(ps.remove(CONFIG, clients.kube, clients.aws, clients.gsm), {"removed": []})

    def test_an_object_not_created_by_the_platform_for_this_app_is_never_deleted(self):
        for change in ("aws", "gcp", "kubernetes"):
            clients = Clients(); clients.run()
            if change == "aws":
                item = clients.aws.secrets[f"cnp/failover/{APP}/runtime"]
                item["Tags"] = [t if t["Key"] != "ManagedBy" else {"Key": "ManagedBy", "Value": "Terraform"} for t in item["Tags"]]
            elif change == "gcp":
                clients.gsm.secrets[GCP_NAME]["meta"]["labels"]["application"] = "other"
            else:
                clients.kube.secrets[CONFIG["kubernetes_secret"]]["metadata"]["labels"]["cnp.io/application"] = "other"
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "suppression refusée"):
                ps.remove(CONFIG, clients.kube, clients.aws, clients.gsm)


def library(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


@unittest.skipUnless(library("kubernetes"), "bibliothèque kubernetes absente")
class KubernetesAdapterTests(unittest.TestCase):
    def setUp(self):
        from kubernetes.client import CoreV1Api, ApiClient
        self.api = create_autospec(CoreV1Api, instance=True)
        self.api.api_client = ApiClient()
        self.adapter = ps.Kubernetes(self.api)

    def test_absent_is_none_and_other_errors_propagate(self):
        from kubernetes.client.exceptions import ApiException
        self.api.read_namespaced_secret.side_effect = ApiException(status=404)
        self.assertIsNone(self.adapter.get("cnp-weather-api-sql"))
        self.api.read_namespaced_secret.assert_called_with("cnp-weather-api-sql", "crossplane-system")
        self.api.read_namespaced_secret.side_effect = ApiException(status=403)
        with self.assertRaises(ApiException):
            self.adapter.get("cnp-weather-api-sql")

    def test_read_returns_plain_data(self):
        from kubernetes.client import V1Secret, V1ObjectMeta
        self.api.read_namespaced_secret.side_effect = None
        self.api.read_namespaced_secret.return_value = V1Secret(metadata=V1ObjectMeta(name="n", labels={"a": "b"}), data={"k": "dg=="})
        self.assertEqual(self.adapter.get("n"), {"metadata": {"name": "n", "labels": {"a": "b"}}, "data": {"k": "dg=="}})

    def test_create_is_create_only_and_a_conflict_is_reported(self):
        from kubernetes.client.exceptions import ApiException
        manifest = {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "n"}}
        self.adapter.create(manifest)
        self.api.create_namespaced_secret.assert_called_once_with("crossplane-system", manifest)
        self.api.create_namespaced_secret.side_effect = ApiException(status=409)
        with self.assertRaises(ps.Exists):
            self.adapter.create(manifest)
        self.assertFalse(self.api.replace_namespaced_secret.called or self.api.patch_namespaced_secret.called)


@unittest.skipUnless(library("google.cloud.secretmanager"), "bibliothèque google-cloud-secret-manager absente")
class SecretManagerAdapterTests(unittest.TestCase):
    def setUp(self):
        from google.cloud import secretmanager
        self.types = secretmanager
        self.client = create_autospec(secretmanager.SecretManagerServiceClient, instance=True)
        self.adapter = ps.SecretManager(self.client)

    def request(self, method):
        return getattr(self.client, method).call_args.kwargs["request"]

    def test_requests_are_valid_for_the_real_api_types(self):
        from google.iam.v1 import iam_policy_pb2, policy_pb2
        sm = self.types
        self.client.get_secret.return_value = sm.Secret(labels={"application": APP})
        self.assertEqual(self.adapter.get_secret(GCP_NAME), {"labels": {"application": APP}})
        sm.GetSecretRequest(self.request("get_secret"))
        self.adapter.create_secret("projects/cnp-terraform-512313", f"{APP}-prod-runtime", {"application": APP}, "europe-west9")
        created = sm.CreateSecretRequest(self.request("create_secret"))
        self.assertEqual(created.secret.replication.user_managed.replicas[0].location, "europe-west9")
        self.client.list_secret_versions.return_value = [sm.SecretVersion(name=GCP_NAME + "/versions/1", state=sm.SecretVersion.State.ENABLED)]
        self.assertEqual(self.adapter.list_versions(GCP_NAME), [{"name": GCP_NAME + "/versions/1", "state": "ENABLED"}])
        sm.ListSecretVersionsRequest(self.request("list_secret_versions"))
        self.client.access_secret_version.return_value = sm.AccessSecretVersionResponse(payload=sm.SecretPayload(data=b"pw"))
        self.assertEqual(self.adapter.access(GCP_NAME + "/versions/1"), "pw")
        sm.AccessSecretVersionRequest(self.request("access_secret_version"))
        self.client.add_secret_version.return_value = sm.SecretVersion(name=GCP_NAME + "/versions/2")
        self.assertEqual(self.adapter.add_version(GCP_NAME, "pw"), GCP_NAME + "/versions/2")
        self.assertEqual(sm.AddSecretVersionRequest(self.request("add_secret_version")).payload.data, b"pw")
        self.client.get_iam_policy.return_value = policy_pb2.Policy(bindings=[policy_pb2.Binding(role="r", members=["m"])], etag=b"e1")
        policy = self.adapter.get_policy(GCP_NAME)
        self.assertEqual(policy, {"bindings": [{"role": "r", "members": ["m"]}], "etag": b"e1"})
        iam_policy_pb2.GetIamPolicyRequest(**self.request("get_iam_policy"))
        self.adapter.set_policy(GCP_NAME, policy)
        sent = iam_policy_pb2.SetIamPolicyRequest(**self.request("set_iam_policy"))       # ce que fait le vrai client d'un dict
        self.assertEqual((sent.policy.etag, sent.policy.bindings[0].members[0]), (b"e1", "m"))

    def test_the_real_client_uses_rest_not_grpc(self):
        from unittest.mock import patch
        with patch.object(self.types, "SecretManagerServiceClient") as client:
            ps.SecretManager.from_environment()
        self.assertEqual(client.call_args.kwargs, {"transport": "rest"})

    def test_absent_and_conflict_are_mapped(self):
        from google.api_core.exceptions import NotFound, AlreadyExists
        self.client.get_secret.side_effect = NotFound("x")
        self.assertIsNone(self.adapter.get_secret(GCP_NAME))
        self.client.create_secret.side_effect = AlreadyExists("x")
        with self.assertRaises(ps.Exists):
            self.adapter.create_secret("projects/p", "s", {}, "europe-west9")


if __name__ == "__main__":
    unittest.main()


class AppSqlSecretsTests(unittest.TestCase):
    """Base Cloud SQL d'un déploiement dev : un mot de passe, créé une fois, copié pour Cloud Run, retiré à la suppression."""
    SA = f"cloud-run-sa@{ps.PROJECT}.iam.gserviceaccount.com"
    GCP = f"projects/{ps.PROJECT}/secrets/weather-api-dev-db-password"

    def test_created_once_then_reused_and_readable_by_cloud_run(self):
        kube, gsm = FakeKube(), FakeGSM()
        first = ps.app_sql_initialize("weather-api", "dev", self.SA, kube, gsm)
        self.assertEqual(first, {"kubernetes_secret": "cnp-weather-api-dev-sql", "gcp_secret": "weather-api-dev-db-password", "initialized": True})
        password = ps.base64.b64decode(kube.secrets["cnp-weather-api-dev-sql"]["data"]["runtime-password"]).decode()
        self.assertEqual(gsm.access(self.GCP + "/versions/1"), password)
        self.assertIn({"role": "roles/secretmanager.secretAccessor", "members": [f"serviceAccount:{self.SA}"]}, gsm.policy["bindings"])
        ps.app_sql_initialize("weather-api", "dev", self.SA, kube, gsm)               # rejouable : aucune nouvelle valeur
        self.assertEqual(len(gsm.secrets[self.GCP]["versions"]), 1)
        self.assertEqual(kube.creates, 1)

    def test_foreign_objects_and_other_environments_are_refused(self):
        kube, gsm = FakeKube(), FakeGSM()
        kube.secrets["cnp-weather-api-dev-sql"] = {"metadata": {"labels": {}}, "data": {"runtime-password": "eA=="}}
        with self.assertRaises(ValueError):
            ps.app_sql_initialize("weather-api", "dev", self.SA, kube, gsm)
        for environment in ("prod", "staging"):
            with self.assertRaises(ValueError):
                ps.app_sql_names("weather-api", environment)                          # la prod passe par le failover

    def test_removal_takes_only_what_the_platform_created(self):
        kube, gsm = FakeKube(), FakeGSM()
        ps.app_sql_initialize("weather-api", "dev", self.SA, kube, gsm)
        result = ps.app_sql_remove("weather-api", "dev", kube, gsm)
        self.assertEqual(result["removed"], [self.GCP, f"{ps.NAMESPACE}/cnp-weather-api-dev-sql"])
        self.assertEqual((kube.secrets, gsm.secrets), ({}, {}))
        self.assertEqual(ps.app_sql_remove("weather-api", "dev", kube, gsm), {"removed": []})     # déjà supprimé
