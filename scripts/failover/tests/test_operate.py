"""Operator regression tests. All provider clients and CLI calls are fake."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).resolve().parents[1] / 'operate.py'
spec = importlib.util.spec_from_file_location('phase1_operator_test', SOURCE)
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)


class OperatorTests(unittest.TestCase):
    def setUp(self):
        parent = SOURCE.parents[2] / 'data' / 'failover-operations'
        parent.mkdir(exist_ok=True, parents=True)
        self.directory = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.directory.cleanup)
        self.document = {'profile': {'gcp': {'app_name': 'weather-api', 'gcp_runtime': {'service_account': 'runtime@example.test'}},
            'aws': {'app_name': 'weather-api'}, 'automation': {'ecs_cluster_arn': 'cluster',
                'ecs_security_group_id': 'sg-test', 'public_subnet_ids': ['subnet-test']}},
            'credentials': {}, 'secrets': {}, 'observations': {}}
        self.request = {'app': 'weather-api', 'work': self.directory.name, 'document': self.document}

    def test_unchanged_credentials_plan_imports_existing_references(self):
        outputs = {'aws_secret_arns': {'value': {'runtime': 'existing-runtime'}}, 'gcp_runtime_secret': {'value': 'existing-gcp'}}
        def cli(args, directory=None):
            if args[1] == 'plan':
                Path(next(value[5:] for value in args if value.startswith('-out='))).write_bytes(b'saved-plan')
            return json.dumps(outputs) if args[1] == 'output' else '{}'
        with patch.object(operator, 'command', side_effect=cli), patch.object(operator.safe_apply, 'inspect', return_value={'safe': True, 'changes': []}):
            result = operator.execute({**self.request, 'action': 'credentials-plan'})
        self.assertEqual(result['credentials'], outputs)
        self.assertNotIn('applied', result)

    def check_worker(self, paused, config_hash):
        app = {'app': 'weather-api'}
        control = {'state': 'DISABLED', 'paused': paused, 'config_hash': config_hash}
        sts, ecs, logs = Mock(), Mock(), Mock()
        sts.get_caller_identity.return_value = {'Account': '804210702561'}
        ecs.describe_task_definition.return_value = {'taskDefinition': {'family': 'cnp-failover-automation-v-1234567890',
            'taskDefinitionArn': 'task-definition', 'containerDefinitions': [{'name': 'worker', 'logConfiguration':
                {'options': {'awslogs-group': 'test-group', 'awslogs-stream-prefix': 'test'}}}]}}
        ecs.run_task.return_value = {'tasks': [{'taskArn': 'task/test'}]}
        ecs.describe_tasks.return_value = {'tasks': [{'containers': [{'exitCode': 0}]}]}
        logs.get_log_events.return_value = {'events': [{'message': json.dumps(control)}]}
        session = Mock()
        session.client.side_effect = lambda name, **kwargs: {'sts': sts, 'ecs': ecs, 'logs': logs}[name]
        fake_boto = types.SimpleNamespace(Session=lambda **kwargs: session)
        with patch.dict(sys.modules, {'boto3': fake_boto}):
            return operator.execute({**self.request, 'action': 'worker-verify', 'task_definition': 'task-definition',
                'packages': {'worker-config.json': {'applications': [app]}}})

    def test_worker_must_be_paused_and_match_the_current_configuration(self):
        expected = hashlib.sha256(b'{"app":"weather-api"}').hexdigest()
        self.assertTrue(self.check_worker(True, expected)['verified'])
        with self.assertRaises(ValueError):
            self.check_worker(False, expected)
        with self.assertRaises(ValueError):
            self.check_worker(True, 'old-profile')

    def test_runtime_does_not_accept_the_previous_ready_revision(self):
        sts, ecs, elb = Mock(), Mock(), Mock()
        sts.get_caller_identity.return_value = {'Account': '804210702561'}
        ecs.describe_services.return_value = {'services': [{'runningCount': 1, 'pendingCount': 0, 'taskDefinition': 'new-task',
            'deployments': [{'status': 'PRIMARY', 'rolloutState': 'COMPLETED', 'taskDefinition': 'new-task'}],
            'loadBalancers': [{'targetGroupArn': 'group'}]}]}
        elb.describe_target_health.return_value = {'TargetHealthDescriptions': [{'TargetHealth': {'State': 'healthy'}}]}
        fake_boto = types.SimpleNamespace(client=lambda name, **kwargs: {'sts': sts, 'ecs': ecs, 'elbv2': elb}[name])
        cloud = {'status': {'conditions': [{'type': 'Ready', 'status': 'True'}],
            'latestReadyRevisionName': 'old-revision', 'latestCreatedRevisionName': 'new-revision'}}
        with patch.dict(sys.modules, {'boto3': fake_boto}), patch.object(operator, 'command', return_value=json.dumps(cloud)):
            result = operator.execute({**self.request, 'action': 'runtime-verify'})
        self.assertFalse(result['verified'])
        self.assertTrue(result['standby_ready'])


class EngineRootTests(unittest.TestCase):
    """Le moteur doit être trouvé dans les deux dispositions du dépôt, sans PYTHONPATH."""

    def engine(self, base, *parts):
        directory = Path(base).joinpath(*parts, 'deployment', 'failover-phase1')
        directory.mkdir(parents=True)
        (directory / 'safe_apply.py').write_text('')
        return directory

    def script(self, base, *parts):
        file = Path(base).joinpath(*parts, 'scripts', 'failover', 'operate.py')
        file.parent.mkdir(parents=True)
        file.write_text('')
        return file.resolve()

    def test_repositories_side_by_side(self):
        with tempfile.TemporaryDirectory() as base:
            expected = self.engine(base, 'cnp')
            here = self.script(base, 'cnp-portal')
            self.assertEqual(operator.engine_root({}, here), expected.resolve())

    def test_portal_nested_inside_cnp(self):
        with tempfile.TemporaryDirectory() as base:
            expected = self.engine(base)
            here = self.script(base, 'cnp-portal')
            self.assertEqual(operator.engine_root({}, here), expected.resolve())

    def test_environment_variable_wins(self):
        with tempfile.TemporaryDirectory() as base, tempfile.TemporaryDirectory() as other:
            self.engine(base)
            chosen = self.engine(other)
            here = self.script(base, 'cnp-portal')
            self.assertEqual(operator.engine_root({'CNP_FAILOVER_ENGINE_ROOT': str(chosen)}, here), chosen.resolve())

    def test_wrong_variable_does_not_fall_back_silently(self):
        with tempfile.TemporaryDirectory() as base:
            self.engine(base)
            here = self.script(base, 'cnp-portal')
            with self.assertRaises(FileNotFoundError):
                operator.engine_root({'CNP_FAILOVER_ENGINE_ROOT': str(Path(base) / 'absent')}, here)

    def test_missing_engine_is_explicit(self):
        with tempfile.TemporaryDirectory() as base:
            here = self.script(base, 'cnp-portal')
            with self.assertRaisesRegex(FileNotFoundError, 'CNP_FAILOVER_ENGINE_ROOT'):
                operator.engine_root({}, here)

    def test_real_layout_resolves_without_pythonpath(self):
        self.assertTrue((operator.ROOT / 'safe_apply.py').is_file())


if __name__ == '__main__':
    unittest.main()
