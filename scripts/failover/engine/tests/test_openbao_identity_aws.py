import copy
import importlib.util
import json
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("identity", Path(__file__).parents[1] / "openbao_identity_aws.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)

ACCOUNT = "123456789012"
BOUNDARY = f"arn:aws:iam::{ACCOUNT}:policy/cnp-runtime/cnp-runtime-exec-boundary"
REQUEST = {"operation": "ensure", "app": "sample-app", "account": ACCOUNT, "region": "eu-west-3", "boundary_arn": BOUNDARY}


class AwsError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class Iam:
    """IAM simulé : applique la limite de droits comme le ferait la simulation réelle (motifs de nom)."""

    def __init__(self, role=None, invisible=0):
        self.roles = {} if role is None else {role["RoleName"]: role}
        self.policies = {}
        self.attached = []
        self.invisible = invisible
        self.created = []

    def get_role(self, RoleName):
        if RoleName not in self.roles:
            raise AwsError("NoSuchEntity")
        return {"Role": copy.deepcopy(self.roles[RoleName])}

    def create_role(self, **kwargs):
        self.created.append(kwargs)
        name = kwargs["RoleName"]
        self.roles[name] = {"RoleName": name, "Path": kwargs["Path"], "Arn": f"arn:aws:iam::{ACCOUNT}:role{kwargs['Path']}{name}",
                            "PermissionsBoundary": {"PermissionsBoundaryArn": kwargs["PermissionsBoundary"]},
                            "AssumeRolePolicyDocument": json.loads(kwargs["AssumeRolePolicyDocument"]), "Tags": kwargs["Tags"]}

    def put_role_policy(self, RoleName, PolicyName, PolicyDocument):
        self.policies[PolicyName] = json.loads(PolicyDocument)

    def list_attached_role_policies(self, RoleName):
        return {"AttachedPolicies": self.attached}

    def list_role_policies(self, RoleName):
        return {"PolicyNames": sorted(self.policies)}

    def get_role_policy(self, RoleName, PolicyName):
        return {"PolicyDocument": self.policies[PolicyName]}

    def simulate_principal_policy(self, PolicySourceArn, ActionNames, ResourceArns):
        if self.invisible:
            self.invisible -= 1
            raise AwsError("NoSuchEntity")
        allowed = [resource for statement in self.policies.get("cnp-runtime-exec", {}).get("Statement", [])
                   if "secretsmanager:GetSecretValue" in statement.get("Action", []) for resource in statement["Resource"]]
        def decide(arn):
            ok = any(arn.startswith(pattern.rstrip("*")) for pattern in allowed)
            return "allowed" if ok else "implicitDeny"
        return {"EvaluationResults": [{"EvalActionName": ActionNames[0], "EvalResourceName": arn, "EvalDecision": decide(arn)}
                                      for arn in ResourceArns]}


class TestAwsRuntimeRole(unittest.TestCase):
    def test_name_matches_portal_derivation(self):
        # Même calcul que awsRuntimeRole() côté portail : sha256("<app>/prod"), 20 caractères.
        self.assertRegex(identity.role_name("sample-app"), r"^cnp-[0-9a-f]{20}-exec$")

    def test_creates_bounded_role_and_proves_isolation(self):
        iam = Iam()
        result = identity.ensure(REQUEST, iam, sleep=lambda _: None)
        name = identity.role_name("sample-app")
        self.assertEqual(result, {"role_arn": f"arn:aws:iam::{ACCOUNT}:role/cnp-runtime/{name}"})
        created = iam.created[0]
        self.assertEqual(created["PermissionsBoundary"], BOUNDARY)
        self.assertEqual(created["Path"], "/cnp-runtime/")
        resources = iam.policies["cnp-runtime-exec"]["Statement"][3]["Resource"]
        self.assertTrue(all(":secret:cnp/failover/sample-app/" in value for value in resources))
        self.assertNotIn("*/", json.dumps(resources))

    def test_is_idempotent(self):
        iam = Iam()
        identity.ensure(REQUEST, iam, sleep=lambda _: None)
        identity.ensure(REQUEST, iam, sleep=lambda _: None)
        self.assertEqual(len(iam.created), 1)

    def test_waits_for_iam_propagation(self):
        iam = Iam(invisible=2)
        waits = []
        identity.ensure(REQUEST, iam, sleep=waits.append)
        self.assertEqual(len(waits), 2)

    def test_gives_up_when_never_effective(self):
        iam = Iam(invisible=100)
        with self.assertRaisesRegex(ValueError, "pas encore effectif"):
            identity.ensure(REQUEST, iam, sleep=lambda _: None, attempts=3)

    def test_refuses_existing_role_outside_scope(self):
        name = identity.role_name("sample-app")
        iam = Iam(role={"RoleName": name, "Path": "/", "Arn": f"arn:aws:iam::{ACCOUNT}:role/{name}", "Tags": []})
        with self.assertRaisesRegex(ValueError, "hors du périmètre"):
            identity.ensure(REQUEST, iam, sleep=lambda _: None)
        self.assertEqual(iam.policies, {})

    def test_refuses_extra_managed_policy(self):
        iam = Iam()
        identity.ensure(REQUEST, iam, sleep=lambda _: None)
        iam.attached = [{"PolicyArn": "arn:aws:iam::aws:policy/AdministratorAccess"}]
        with self.assertRaisesRegex(ValueError, "hors du périmètre"):
            identity.ensure(REQUEST, iam, sleep=lambda _: None)

    def test_refuses_role_reading_other_secrets(self):
        iam = Iam()
        original = identity.policy
        try:
            identity.policy = lambda app, account, region: {"Version": "2012-10-17", "Statement": [{}, {}, {}, {
                "Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
                "Resource": [f"arn:aws:secretsmanager:{region}:{account}:secret:cnp/failover/*"]}]}
            with self.assertRaisesRegex(ValueError, "Isolation"):
                identity.ensure(REQUEST, iam, sleep=lambda _: None)
        finally:
            identity.policy = original

    def test_rejects_invalid_parameters(self):
        for change in ({"app": "Bad_App"}, {"account": "12"}, {"boundary_arn": "arn:aws:iam::123456789012:policy/other"}):
            with self.assertRaisesRegex(ValueError, "invalides"):
                identity.ensure({**REQUEST, **change}, Iam(), sleep=lambda _: None)


if __name__ == "__main__":
    unittest.main()
