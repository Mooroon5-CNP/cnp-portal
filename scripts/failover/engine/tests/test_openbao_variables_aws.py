import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("delivery", Path(__file__).parents[1] / "openbao_variables_aws.py")
delivery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(delivery)


class Missing(Exception):
    response = {"Error": {"Code": "ResourceNotFoundException"}}


class Client:
    def __init__(self):
        self.created = []
        self.put = []
        self.existing = None

    def describe_secret(self, **_):
        if self.existing is None:
            raise Missing()
        return self.existing

    def create_secret(self, **kwargs):
        self.created.append(kwargs)
        return {"ARN": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:" + kwargs["Name"] + "-AbCd12"}

    def put_secret_value(self, **kwargs):
        self.put.append(kwargs)


class TestAwsVariables(unittest.TestCase):
    def test_creates_versioned_secret_without_exposing_value(self):
        client = Client()
        refs = delivery.execute({"app": "sample-app", "region": "eu-west-3",
                                 "generation": "11111111-1111-1111-1111-111111111111",
                                 "values": {"API_KEY": "private-value"}}, client)
        self.assertEqual(len(refs), 1)
        self.assertEqual(client.created[0]["SecretString"], "private-value")
        self.assertEqual(client.created[0]["ClientRequestToken"], refs[0]["valueFrom"].split(":::")[-1])
        self.assertNotIn("private-value", str(refs))

    def test_refuses_existing_secret_not_owned_by_portal(self):
        client = Client()
        client.existing = {"ARN": "arn:aws:secretsmanager:eu-west-3:123456789012:secret:cnp/failover/sample-app/env-123456789abc-AbCd12",
                           "Tags": [{"Key": "Application", "Value": "other-app"}]}
        with self.assertRaisesRegex(ValueError, "hors du périmètre"):
            delivery.execute({"app": "sample-app", "region": "eu-west-3",
                              "generation": "11111111-1111-1111-1111-111111111111",
                              "values": {"API_KEY": "private-value"}}, client)
        self.assertEqual(client.put, [])


if __name__ == "__main__":
    unittest.main()
