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
from unittest.mock import Mock, create_autospec, patch

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

    def test_platform_secrets_are_created_by_the_api_without_terraform_or_any_cli(self):
        sys.path.insert(0, str(SOURCE.parents[3] / 'config-repo' / 'scripts' / 'tests'))
        import test_worker_phase1 as fixtures
        profile = fixtures.platform_profile()
        app = profile['gcp']['app_name']
        expected = {'secrets': {'app': app, 'initialized': True}, 'credentials': {'aws_secret_arns': {'value': {}}}}
        request = {'app': app, 'work': self.directory.name, 'action': 'initialize-secrets',
                   'document': {'profile': profile, 'credentials': {}, 'secrets': {}, 'observations': {}}}
        with patch('initialize_secrets.initialize', side_effect=AssertionError('chemin du pilote')), \
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
        self.aws = fake_boto
        ready = self.runtime(SERVICE)
        self.assertTrue(ready['verified'])
        for change in ({'latestReadyRevision': SERVICE['latestReadyRevision'].replace('00002', '00001')},     # ancienne révision prête
                       {'reconciling': True}, {'terminalCondition': {'state': 'CONDITION_FAILED'}}):
            with self.subTest(change=change):
                result = self.runtime({**SERVICE, **change})
                self.assertFalse(result['primary_ready'])
                self.assertTrue(result['standby_ready'])

    def runtime(self, service):
        session = FakeSession({f'https://run.googleapis.com/v2/projects/cnp-terraform-512313/locations/europe-west9/services/weather-api-prod': service})
        with patch.dict(sys.modules, {'boto3': self.aws}):
            return operator.execute({**self.request, 'action': 'runtime-verify', '_google': session})


REVISION = 'projects/cnp-terraform-512313/locations/europe-west9/services/weather-api-prod/revisions/weather-api-prod-00002-abc'
# Forme réelle de l'API Cloud Run v2, relevée sur cnp-test-azure-prod le 6/11 : `reconciling` est ABSENT quand il est faux.
SERVICE = {'terminalCondition': {'state': 'CONDITION_SUCCEEDED', 'type': 'Ready'},
           'latestReadyRevision': REVISION, 'latestCreatedRevision': REVISION,
           'template': {'containers': [{'image': 'europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/weather-api@sha256:' + 'a' * 64}]}}


class FakeSession:
    """Session Google : réponses JSON par URL ; toute autre URL est un refus."""
    def __init__(self, pages):
        self.pages, self.urls = pages, []

    def get(self, url, timeout):
        self.urls.append(url)
        found = url in self.pages
        return types.SimpleNamespace(status_code=200 if found else 403, json=lambda: self.pages[url])


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
        (directory / 'bootstrap.py').write_text('')
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


class NoCommandLineTests(unittest.TestCase):
    """Le portail tournera dans le cluster : aucune CLI (terraform, gcloud, kubectl), aucun plan ni apply."""

    def test_the_operator_never_starts_a_process(self):
        import ast
        tree = ast.parse(SOURCE.read_text())
        imported = {alias.name.split('.')[0] for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
                    for alias in (node.names if isinstance(node, ast.Import) else [ast.alias(node.module or '')])}
        self.assertFalse(imported & {'subprocess', 'shutil', 'safe_apply'}, imported)
        tools = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and node.value in {'terraform', 'gcloud', 'kubectl'}]
        self.assertEqual(tools, [])
        self.assertNotIn('os.system', SOURCE.read_text())

    def test_plan_and_apply_actions_no_longer_exist(self):
        parent = SOURCE.parents[2] / 'data' / 'failover-operations'
        parent.mkdir(exist_ok=True, parents=True)
        with tempfile.TemporaryDirectory(dir=parent) as work:
            document = {'profile': {'gcp': {'app_name': 'weather-api'}, 'aws': {'app_name': 'weather-api'}, 'automation': {}},
                        'credentials': {}, 'secrets': {}, 'observations': {}}
            for action in ('credentials-plan', 'automation-plan', 'apply'):
                with self.subTest(action=action), self.assertRaisesRegex(ValueError, 'Opération inconnue'):
                    operator.execute({'app': 'weather-api', 'work': work, 'action': action, 'document': document})

    def test_platform_and_pilot_task_families_only(self):
        for family in ('cnp-failover-platform-bootstrap', 'cnp-failover-platform-worker', 'cnp-failover-bootstrap', 'cnp-failover-automation-v-0123456789'):
            self.assertRegex(family, f'^(?:{operator.TASK_FAMILY})$')
        for family in ('cnp-failover-platform-other', 'other-worker', 'cnp-failover-platform-worker-v-0123456789'):
            self.assertNotRegex(family, f'^(?:{operator.TASK_FAMILY})$')


@unittest.skipUnless(importlib.util.find_spec('kubernetes'), 'bibliothèque kubernetes absente')
class ObserveTests(unittest.TestCase):
    """Les observations se lisent par l'API Kubernetes, à la version préférée du cluster (celle que prenait kubectl)."""

    def setUp(self):
        from kubernetes.client import ApisApi, CustomObjectsApi, V1APIGroup, V1APIGroupList, V1GroupVersionForDiscovery
        self.apis = create_autospec(ApisApi, instance=True)
        groups = [('sql.gcp.upbound.io', 'v1beta2'), ('rds.aws.upbound.io', 'v1beta3'), ('route53.aws.upbound.io', 'v1beta1')]
        self.apis.get_api_versions.return_value = V1APIGroupList(groups=[V1APIGroup(name=name, versions=[], preferred_version=
            V1GroupVersionForDiscovery(group_version=f'{name}/{version}', version=version)) for name, version in groups])
        self.custom = create_autospec(CustomObjectsApi, instance=True)
        self.objects = {}
        def get(group, version, plural, name):
            from kubernetes.client.exceptions import ApiException
            if (plural, name) not in self.objects:
                raise ApiException(status=self.missing)
            return {'apiVersion': f'{group}/{version}', **self.objects[(plural, name)]}
        self.custom.get_cluster_custom_object.side_effect = get
        self.missing = 404

    def test_preferred_versions_and_absent_probes_before_dns(self):
        self.objects = {('databaseinstances', 'weather-api-prod-gcp-db'): {'kind': 'DatabaseInstance'}, ('instances', 'weather-api-prod-db'): {'kind': 'Instance'}}
        found = operator.observe_objects('weather-api', self.apis, self.custom)
        self.assertEqual(set(found), {'cloudsql', 'rds'})
        self.assertEqual(found['rds']['apiVersion'], 'rds.aws.upbound.io/v1beta3')          # pas celle écrite dans Git (v1beta2)
        self.assertEqual(found['cloudsql']['apiVersion'], 'sql.gcp.upbound.io/v1beta2')

    def test_a_missing_database_or_a_refused_read_stops(self):
        self.objects = {('databaseinstances', 'weather-api-prod-gcp-db'): {'kind': 'DatabaseInstance'}}
        with self.assertRaisesRegex(ValueError, 'Bases'):
            operator.observe_objects('weather-api', self.apis, self.custom)
        self.objects[('instances', 'weather-api-prod-db')] = {'kind': 'Instance'}
        self.missing = 403                                                                   # droits refusés sur les sondes
        with self.assertRaisesRegex(ValueError, 'sondes refusée'):
            operator.observe_objects('weather-api', self.apis, self.custom)

    def observe(self, objects, expect_probes=False):
        sys.path.insert(0, str(SOURCE.parents[3] / 'config-repo' / 'scripts' / 'tests'))
        import test_worker_phase1 as fixtures
        profile = fixtures.platform_profile()
        app = profile['gcp']['app_name']
        self.objects = {(plural, name.format(app=app)): value for (plural, name), value in objects.items()}
        session = FakeSession({f'https://sqladmin.googleapis.com/v1/projects/cnp-terraform-512313/instances/{app}-prod-gcp-db':
                               {'serverCaCert': {'cert': 'CA'}}})
        parent = SOURCE.parents[2] / 'data' / 'failover-operations'
        parent.mkdir(exist_ok=True, parents=True)
        with tempfile.TemporaryDirectory(dir=parent) as work:
            return operator.execute({'app': app, 'work': work, 'action': 'observe', '_google': session, '_kubernetes': (self.apis, self.custom),
                'expect_probes': expect_probes, 'document': {'profile': profile, 'credentials': fixtures.platform_outputs(), 'secrets': {}, 'observations': {}}})

    def test_an_observation_proves_nothing_until_both_databases_are_ready(self):
        ok = {'status': {'conditions': [{'type': 'Ready', 'status': 'True'}, {'type': 'Synced', 'status': 'True'}]}}
        creating = {'status': {'conditions': [{'type': 'Ready', 'status': 'False'}, {'type': 'Synced', 'status': 'True'}]}}
        result = self.observe({('databaseinstances', '{app}-prod-gcp-db'): ok, ('instances', '{app}-prod-db'): creating})
        self.assertIs(result['verified'], False)
        self.assertIn('rds', result['message'])
        self.assertIs(self.observe({('databaseinstances', '{app}-prod-gcp-db'): ok, ('instances', '{app}-prod-db'): ok})['verified'], True)

    def test_after_dns_the_probes_must_be_ready_too(self):
        ok = {'status': {'conditions': [{'type': 'Ready', 'status': 'True'}, {'type': 'Synced', 'status': 'True'}]}}
        dbs = {('databaseinstances', '{app}-prod-gcp-db'): ok, ('instances', '{app}-prod-db'): ok}
        self.assertIs(self.observe(dbs, expect_probes=True)['verified'], False)
        probes = {('healthchecks', '{app}-failover'): ok, ('healthchecks', '{app}-failover-latch-http'): ok, ('healthchecks', '{app}-failover-primary-health'): ok}
        self.assertIs(self.observe({**dbs, **probes}, expect_probes=True)['verified'], True)

    def test_the_action_reads_the_source_ca_from_the_cloud_sql_api(self):
        sys.path.insert(0, str(SOURCE.parents[3] / 'config-repo' / 'scripts' / 'tests'))
        import test_worker_phase1 as fixtures
        profile = fixtures.platform_profile()
        app = profile['gcp']['app_name']
        self.objects = {('databaseinstances', f'{app}-prod-gcp-db'): {'kind': 'DatabaseInstance'}, ('instances', f'{app}-prod-db'): {'kind': 'Instance'}}
        session = FakeSession({f'https://sqladmin.googleapis.com/v1/projects/cnp-terraform-512313/instances/{app}-prod-gcp-db':
                               {'serverCaCert': {'cert': '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----'}}})
        parent = SOURCE.parents[2] / 'data' / 'failover-operations'
        parent.mkdir(exist_ok=True, parents=True)
        with tempfile.TemporaryDirectory(dir=parent) as work:
            result = operator.execute({'app': app, 'work': work, 'action': 'observe', '_google': session, '_kubernetes': (self.apis, self.custom),
                'document': {'profile': profile, 'credentials': fixtures.platform_outputs(), 'secrets': {}, 'observations': {}}})
        self.assertIn('BEGIN CERTIFICATE', result['source_ca'])
        self.assertEqual(set(result['observations']), {'cloudsql', 'rds'})


class HealthNamesTests(unittest.TestCase):
    """La santé d'une app lit les objets de son régime : jamais la table ni les règles du worker du pilote pour une app plateforme."""

    def health(self, profile):
        app = profile['gcp']['app_name']
        clients = {name: Mock() for name in ('sts', 'ecs', 'route53', 'dynamodb', 'events')}
        clients['sts'].get_caller_identity.return_value = {'Account': '804210702561'}
        clients['ecs'].describe_services.return_value = {'services': []}
        clients['route53'].list_resource_record_sets.return_value = {'ResourceRecordSets': []}
        clients['dynamodb'].get_item.return_value = {}
        clients['events'].describe_rule.return_value = {'State': 'ENABLED'}
        clients['events'].list_targets_by_rule.return_value = {'Targets': []}
        fake_boto = types.SimpleNamespace(client=lambda name, **kwargs: clients[name])
        parent = SOURCE.parents[2] / 'data' / 'failover-operations'
        parent.mkdir(exist_ok=True, parents=True)
        with tempfile.TemporaryDirectory(dir=parent) as work, patch.dict(sys.modules, {'boto3': fake_boto}), \
                patch('urllib.request.urlopen', side_effect=OSError('hors ligne')):
            result = operator.execute({'app': app, 'work': work, 'action': 'health', 'task_definition': 'cnp-failover-platform-worker',
                'packages': {'worker-config.json': {'applications': [{'app': app}]}},
                'document': {'profile': profile, 'credentials': {}, 'secrets': {}, 'observations': {}}})
        return result, clients

    def test_each_regime_reads_its_own_state_table_and_rules(self):
        sys.path.insert(0, str(SOURCE.parents[3] / 'config-repo' / 'scripts' / 'tests'))
        import test_worker_phase1 as fixtures
        from test_phase1_package import profile as pilot
        for profile, table, rule in ((fixtures.platform_profile(), 'cnp-failover-platform-state', 'cnp-failover-platform-'),
                                     (pilot(), 'cnp-failover-automation', 'cnp-failover-automation-')):
            with self.subTest(table=table):
                result, clients = self.health(profile)
                self.assertFalse(result['verified'])
                self.assertEqual({call.kwargs['TableName'] for call in clients['dynamodb'].get_item.call_args_list}, {table})
                rules = [call.kwargs['Name'] for call in clients['events'].describe_rule.call_args_list]
                self.assertEqual(rules, [rule + 'alarm', rule + 'retry'])
