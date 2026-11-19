import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).parents[1] / 'openbao_cleanup_aws.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class Missing(Exception):
    response = {'Error': {'Code': 'ResourceNotFoundException'}}


class Client:
    def __init__(self, owned=True):
        self.owned = owned
        self.deleted = []

    def describe_secret(self, **_):
        return {'ARN': 'arn:aws:secretsmanager:eu-west-3:123456789012:secret:owned-AbCd12', 'Tags': [
            {'Key': 'Application', 'Value': 'sample-app' if self.owned else 'other-app'},
            {'Key': 'Environment', 'Value': 'prod'},
            {'Key': 'ManagedBy', 'Value': 'cnp-portal-variables'},
        ]}

    def delete_secret(self, **kwargs):
        self.deleted.append(kwargs)


class TestCleanup(unittest.TestCase):
    def test_schedules_only_owned_secret_for_recoverable_deletion(self):
        client = Client()
        cleanup.execute({'app': 'sample-app', 'names': ['API_KEY'], 'region': 'eu-west-3'}, client)
        self.assertEqual(client.deleted[0]['RecoveryWindowInDays'], 7)

    def test_refuses_secret_owned_by_another_application(self):
        client = Client(owned=False)
        with self.assertRaisesRegex(ValueError, 'hors du périmètre'):
            cleanup.execute({'app': 'sample-app', 'names': ['API_KEY'], 'region': 'eu-west-3'}, client)
        self.assertEqual(client.deleted, [])


if __name__ == '__main__':
    unittest.main()
