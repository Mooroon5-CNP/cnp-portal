"""Operator regression tests. All provider clients and CLI calls are fake."""
import hashlib
import importlib.util
import io
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

    def test_platform_secrets_are_created_by_the_api_without_terraform_or_any_cli(self):
        sys.path.insert(0, str(SOURCE.parents[3] / 'config-repo' / 'scripts' / 'tests'))
        import test_worker_phase1 as fixtures
        profile = fixtures.platform_profile()
        app = profile['gcp']['app_name']
        expected = {'secrets': {'app': app, 'initialized': True}, 'credentials': {'aws_secret_arns': {'value': {}}}}
        request = {'app': app, 'work': self.directory.name, 'action': 'initialize-secrets',
                   'document': {'profile': profile, 'credentials': {}, 'secrets': {}, 'observations': {}}}
        with patch.object(operator, 'command', side_effect=AssertionError('CLI appelée')), \
                patch('initialize_secrets.initialize', side_effect=AssertionError('chemin du pilote')), \
                patch('platform_secrets.execute', return_value=expected) as run:
            self.assertEqual(operator.execute(request), expected)
        self.assertEqual(run.call_args.args[0], {'app': app, 'kubernetes_secret': profile['gcp']['credentials_secret_name'],
                                                 'gcp_runtime_service_account': profile['gcp']['gcp_runtime']['service_account']})

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


INTROSPECTED = 'postgres:{"database":"appdb"}'
READY = {'schema_ready': True, 'tables': 3, 'unsupported': [], 'operation': 'inspect-source', 'completed': True}


class BootstrapOrchestrationTests(unittest.TestCase):
    """Initialisation SQL en deux phases pour un profil introspecté ; l'ancien enchaînement reste inchangé."""

    def setUp(self):
        parent = SOURCE.parents[2] / 'data' / 'failover-operations'
        parent.mkdir(exist_ok=True, parents=True)
        self.directory = tempfile.TemporaryDirectory(dir=parent)
        self.addCleanup(self.directory.cleanup)
        self.document = {'profile': {'gcp': {'app_name': 'weather-api'}, 'aws': {'app_name': 'weather-api'},
            'automation': {'ecs_cluster_arn': 'cluster', 'ecs_security_group_id': 'sg-test', 'public_subnet_ids': ['subnet-test']}},
            'credentials': {}, 'secrets': {}, 'observations': {}}

    def run_action(self, action, outputs, profile=INTROSPECTED):
        """Exécute l'action avec de faux ECS et journaux ; chaque tâche lit la sortie suivante de `outputs`."""
        sts, ecs, logs = Mock(), Mock(), Mock()
        sts.get_caller_identity.return_value = {'Account': '804210702561'}
        ecs.describe_task_definition.return_value = {'taskDefinition': {'family': 'cnp-failover-bootstrap-v-1234567890',
            'taskDefinitionArn': 'task-definition', 'containerDefinitions': [{'name': 'bootstrap', 'logConfiguration':
                {'options': {'awslogs-group': 'test-group', 'awslogs-stream-prefix': 'test'}}}]}}
        counter = iter(range(1, 50))
        ecs.run_task.side_effect = lambda **kwargs: {'tasks': [{'taskArn': f'task/{next(counter)}'}]}
        ecs.describe_tasks.return_value = {'tasks': [{'containers': [{'exitCode': 0}]}]}
        pending = iter(outputs)
        logs.get_log_events.side_effect = lambda **kwargs: {'events': [{'message': json.dumps(next(pending))}]}
        session = Mock()
        session.client.side_effect = lambda name, **kwargs: {'sts': sts, 'ecs': ecs, 'logs': logs}[name]
        self.ecs = ecs
        request = {'app': 'weather-api', 'work': self.directory.name, 'document': self.document, 'action': action,
            'task_definition': 'task-definition', 'packages': {'bootstrap-config.json': {'app': 'weather-api', 'profile': profile}}}
        with patch.dict(sys.modules, {'boto3': types.SimpleNamespace(Session=lambda **kwargs: session)}):
            return operator.execute(request)

    def launched(self):
        return [call.kwargs['overrides']['containerOverrides'][0]['command'][0] for call in self.ecs.run_task.call_args_list]

    def test_operation_order_depends_on_the_profile(self):
        self.assertEqual(operator.bootstrap_operations('bootstrap', True),
                         ['prepare-source', 'restore-schema', 'prepare-target', 'verify-native-tls', 'subscribe'])
        self.assertEqual(operator.bootstrap_operations('bootstrap', False),
                         ['prepare-source', 'create-target-runtime', 'prepare-target', 'verify-native-tls', 'subscribe'])
        self.assertEqual(operator.bootstrap_operations('bootstrap-roles', True), ['create-target-runtime'])
        self.assertEqual(operator.bootstrap_operations('schema-check', True), ['inspect-source'])

    def test_phase_two_restores_the_schema_before_the_subscription_and_never_recreates_the_role(self):
        self.run_action('bootstrap', [{'completed': True}] * 5)
        commands = self.launched()
        self.assertEqual(len(commands), 5)
        order = [next(name for name in ('prepare-source', 'restore-schema', 'prepare-target', 'verify-native-tls', 'subscribe', 'create-target-runtime')
                      if f"'{name}'" in command or f'"{name}"' in command or f' {name} ' in command) for command in commands]
        self.assertEqual(order, ['prepare-source', 'restore-schema', 'prepare-target', 'verify-native-tls', 'subscribe'])
        self.assertNotIn('create-target-runtime', order)

    def test_roles_phase_only_creates_the_target_role(self):
        self.run_action('bootstrap-roles', [{'completed': True}])
        self.assertEqual(len(self.launched()), 1)
        self.assertIn('create-target-runtime', self.launched()[0])

    def test_phases_for_an_introspected_profile_are_refused_for_a_legacy_profile(self):
        for action in ('bootstrap-roles', 'schema-check'):
            with self.assertRaises(ValueError):
                self.run_action(action, [READY], profile='pixelcalm')

    def test_schema_check_is_verified_only_when_the_application_created_its_schema(self):
        ready = self.run_action('schema-check', [READY])
        self.assertTrue(ready['verified'] and ready['schema_ready'])
        self.assertEqual(ready['tables'], 3)
        empty = self.run_action('schema-check', [{**READY, 'schema_ready': False, 'tables': 0}])
        self.assertFalse(empty['verified'])
        self.assertIn('l\'appeler', empty['message'])

    def test_a_schema_check_is_never_answered_by_an_older_task(self):
        # Après correction du schéma, la relecture doit lancer une nouvelle tâche : réutiliser l'ancienne figerait le résultat.
        self.run_action('schema-check', [{**READY, 'schema_ready': False, 'tables': 0}])
        first = [call.kwargs['clientToken'] for call in self.ecs.run_task.call_args_list]
        self.run_action('schema-check', [READY])          # même dossier de travail : une reprise réutiliserait l'ancienne tâche
        again = [call.kwargs['clientToken'] for call in self.ecs.run_task.call_args_list]
        self.assertEqual((len(first), len(again)), (1, 1))
        self.assertNotEqual(first, again)

    def test_schema_check_names_unsupported_objects_for_the_manager(self):
        with self.assertRaises(operator.UserAction) as caught:
            self.run_action('schema-check', [{**READY, 'schema_ready': False, 'unsupported': ['table hors du schéma public : billing.invoices']}])
        self.assertIn('billing.invoices', str(caught.exception))

    def proof(self, **changes):
        return {'fresh_write_replayed': True, 'enabled': True, 'tables_ready': True, 'slot_active': True,
                'last_message_age_seconds': 3, **changes}

    def test_an_introspected_schema_must_be_proven_identical_on_both_sides(self):
        self.assertTrue(self.run_action('verify', [self.proof(schema_in_sync=True)])['verified'])
        for proof in (self.proof(schema_in_sync=False), self.proof()):           # divergent, ou mesure absente
            with self.assertRaises(ValueError):
                self.run_action('verify', [proof])

    def test_legacy_profiles_only_refuse_a_schema_proven_different(self):
        self.assertTrue(self.run_action('verify', [self.proof()], profile='pixelcalm')['verified'])
        with self.assertRaises(ValueError):
            self.run_action('verify', [self.proof(schema_in_sync=False)], profile='pixelcalm')


class EntryPointTests(unittest.TestCase):
    def run_main(self, error):
        out = io.StringIO()
        with patch.object(operator, 'execute', side_effect=error), patch('sys.stdin', io.StringIO('{}')), patch('sys.stdout', out):
            with self.assertRaises(SystemExit):
                operator.main()
        return json.loads(out.getvalue())

    def test_a_known_cause_is_shown_to_the_manager(self):
        shown = self.run_main(operator.UserAction('Schéma non pris en charge : billing.invoices.'))
        self.assertEqual(shown, {'error': 'Schéma non pris en charge : billing.invoices.', 'action_required': True})

    def test_an_unknown_failure_stays_generic(self):
        shown = self.run_main(RuntimeError('connection to 10.189.0.3 failed for user admin password=hunter2'))
        self.assertNotIn('hunter2', json.dumps(shown))
        self.assertNotIn('action_required', shown)


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
