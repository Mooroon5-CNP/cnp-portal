import importlib.util
import json
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("render_portal", Path(__file__).parents[2] / "render.py")
portal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(portal)


class TestRuntimeVariables(unittest.TestCase):
    def input(self):
        prefix = "apps/sample-app/crossplane/prod/"
        result = {
            prefix + "cloudrun-claim.yaml": {"spec": {"forProvider": {"template": {"containers": [{"env": [{"name": "DB_PASSWORD"}]}]}}}},
            prefix + "ecs-task-definition.yaml": {"spec": {"forProvider": {
                "containerDefinitions": json.dumps([{"name": "app", "secrets": [{"name": "DB_PASSWORD", "valueFrom": "db-arn"}]}])}}},
        }
        profile = {"gcp": {"app_name": "sample-app"}, "aws": {"app_name": "sample-app", "listener_priority": 100}}
        refs = {"gcp": [{"name": "API_KEY", "valueSource": {"secretKeyRef": {"secret": "app-key", "version": "4"}}}],
                "aws": [{"name": "API_KEY", "valueFrom": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:cnp/failover/sample-app/env-123456789abc-AbCd12:::11111111-1111-1111-1111-111111111111"}],
                "aws_execution_role": "arn:aws:iam::123456789012:role/sample-app-prod-execution"}
        return result, profile, refs

    def test_both_clouds_receive_only_pinned_references(self):
        result, profile, refs = self.input()
        portal.inject_runtime_variables(result, profile, refs)
        prefix = "apps/sample-app/crossplane/prod/"
        self.assertIn(refs["gcp"][0], result[prefix + "cloudrun-claim.yaml"]["spec"]["forProvider"]["template"]["containers"][0]["env"])
        task = result[prefix + "ecs-task-definition.yaml"]
        container = json.loads(task["spec"]["forProvider"]["containerDefinitions"])[0]
        self.assertIn(refs["aws"][0], container["secrets"])
        self.assertEqual(task["spec"]["forProvider"]["executionRoleArn"], refs["aws_execution_role"])
        self.assertEqual(result[prefix + "ecs-service.yaml"]["spec"]["forProvider"]["taskDefinitionRef"]["name"], task["metadata"]["name"])

    def test_conflicting_runtime_variable_fails_before_mutation(self):
        result, profile, refs = self.input()
        refs["gcp"][0]["name"] = "DB_PASSWORD"
        with self.assertRaisesRegex(ValueError, "conflit"):
            portal.inject_runtime_variables(result, profile, refs)

    def test_only_portal_owned_previous_references_are_selected_for_replacement(self):
        app = "sample-app"
        self.assertTrue(portal.managed_gcp_variable({"valueSource": {"secretKeyRef": {
            "secret": "cnp-sample-app-prod-var-123456789abc", "version": "4"}}}, app))
        self.assertFalse(portal.managed_gcp_variable({"name": "DB_PASSWORD", "valueSource": {
            "secretKeyRef": {"secret": "cnp-sample-app-prod-db-password", "version": "latest"}}}, app))
        self.assertTrue(portal.managed_aws_variable({"valueFrom": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:cnp/failover/sample-app/env-123456789abc-AbCd12:::11111111-1111-1111-1111-111111111111"}, app))
        self.assertFalse(portal.managed_aws_variable({"valueFrom": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:cnp/failover/sample-app/runtime-AbCd12:password::"}, app))


if __name__ == "__main__":
    unittest.main()
