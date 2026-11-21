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
    def test_deletes_only_owned_secret_without_recovery_window(self):
        client = Client()
        cleanup.execute({'app': 'sample-app', 'names': ['API_KEY'], 'region': 'eu-west-3'}, client)
        self.assertEqual(client.deleted, [{'SecretId': 'arn:aws:secretsmanager:eu-west-3:123456789012:secret:owned-AbCd12',
                                           'ForceDeleteWithoutRecovery': True}])

    def test_purges_secret_already_scheduled_for_deletion(self):
        client = Client()
        original = client.describe_secret
        client.describe_secret = lambda **kwargs: {**original(**kwargs), 'DeletedDate': '2026-11-21'}
        cleanup.execute({'app': 'sample-app', 'names': ['API_KEY'], 'region': 'eu-west-3'}, client)
        self.assertTrue(client.deleted[0]['ForceDeleteWithoutRecovery'])

    def test_refuses_secret_owned_by_another_application(self):
        client = Client(owned=False)
        with self.assertRaisesRegex(ValueError, 'hors du périmètre'):
            cleanup.execute({'app': 'sample-app', 'names': ['API_KEY'], 'region': 'eu-west-3'}, client)
        self.assertEqual(client.deleted, [])


if __name__ == '__main__':
    unittest.main()
