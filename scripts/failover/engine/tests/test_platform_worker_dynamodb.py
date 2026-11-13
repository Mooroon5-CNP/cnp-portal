"""Garde de configuration du worker contre un vrai moteur DynamoDB (conditions, transactions, pagination).

Les tests unitaires simulent DynamoDB ; ceux-ci vérifient que les conditions écrites par le worker se comportent comme prévu
sur le vrai service. Lancement : python tests/run_docker_dynamodb.py
"""
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import automation as a
from test_platform_worker import app as application

URL = os.environ.get('CNP_LOCAL_DYNAMODB_URL', '')
TOPIC = f"arn:aws:sns:{a.REGION}:{a.ACCOUNT}:{a.PLATFORM['topic']}"


def changed(name, host):
    value = application(name)
    value['source']['host'] = host
    return value


@unittest.skipUnless(URL, 'Lanceur local explicite requis : python tests/run_docker_dynamodb.py')
class PlatformWorkerOnRealDynamoDB(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import boto3
        cls.client = boto3.client('dynamodb', endpoint_url=URL, region_name=a.REGION,
            aws_access_key_id='local', aws_secret_access_key='local')
        cls.client.create_table(TableName=a.PLATFORM['state_table'], BillingMode='PAY_PER_REQUEST',
            AttributeDefinitions=[{'AttributeName': 'app', 'AttributeType': 'S'}, {'AttributeName': 'record', 'AttributeType': 'S'}],
            KeySchema=[{'AttributeName': 'app', 'KeyType': 'HASH'}, {'AttributeName': 'record', 'KeyType': 'RANGE'}])
        cls.client.create_table(TableName=a.PLATFORM['config_table'], BillingMode='PAY_PER_REQUEST',
            AttributeDefinitions=[{'AttributeName': 'app', 'AttributeType': 'S'}],
            KeySchema=[{'AttributeName': 'app', 'KeyType': 'HASH'}])

    def setUp(self):
        for table, keys in ((a.PLATFORM['state_table'], ('app', 'record')), (a.PLATFORM['config_table'], ('app',))):
            for row in self.client.scan(TableName=table)['Items']:
                self.client.delete_item(TableName=table, Key={key: row[key] for key in keys})
        patcher = patch.object(a.ssl, 'create_default_context')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sns = Mock()
        self.store = a.Store(self.client, a.PLATFORM['state_table'], TOPIC, self.sns)

    def publish_config(self, value):
        self.client.put_item(TableName=a.PLATFORM['config_table'], Item={'app': {'S': value['app']}, 'config': {'S': json.dumps(value)}})

    def events(self, name):
        rows = self.client.query(TableName=a.PLATFORM['state_table'], ConsistentRead=True,
            KeyConditionExpression='app=:a AND begins_with(#r,:p)', ExpressionAttributeNames={'#r': 'record'},
            ExpressionAttributeValues={':a': {'S': name}, ':p': {'S': 'EVENT#'}})['Items']
        return [a.decode(row) for row in rows]

    def test_every_page_of_a_real_scan_is_read_and_a_bad_item_is_isolated(self):
        for index in range(5):
            self.publish_config(application(f'app-{index}'))
        self.client.put_item(TableName=a.PLATFORM['config_table'], Item={'app': {'S': 'broken-api'}, 'config': {'S': '{"app": '}})
        apps, invalid = a.ConfigTable(self.client, a.PLATFORM['config_table'], page_size=2).applications()
        self.assertEqual([value['app'] for value in apps], [f'app-{index}' for index in range(5)])
        self.assertEqual(invalid, ['broken-api'])

    def test_a_configuration_must_be_verified_before_it_can_act(self):
        v1 = application('weather-api')
        self.store.configure(v1)
        control = self.store.control('weather-api')
        self.assertEqual((control['paused'], control['state'], control['config_hash']), (True, 'DISABLED', a.config_hash(v1)))
        self.assertFalse(self.store.acquire(v1, 'first'))            # configurée mais en pause : pas de bail
        self.store.pause(v1, False)                                  # reprise : la configuration a été vérifiée
        self.assertTrue(self.store.acquire(v1, 'first'))
        self.assertFalse(self.store.acquire(v1, 'second'))           # un seul bail à la fois
        self.store.checkpoint(v1, 'first')
        self.store.release(v1, 'first')

    def test_a_changed_configuration_cannot_take_the_lease_pause_or_transition(self):
        v1, v2 = application('weather-api'), changed('weather-api', '10.189.0.4')
        self.store.configure(v1)
        self.store.pause(v1, False)
        self.assertFalse(self.store.acquire(v2, 'owner'))            # l'empreinte ne correspond plus
        with self.assertRaises(Exception) as caught:
            self.store.pause(v2, True)
        self.assertEqual(a.conditional_failure(caught.exception), True)
        self.assertTrue(self.store.acquire(v1, 'owner'))
        with self.assertRaises(Exception):                           # même avec un bail valide, la transaction refuse
            self.store.transition(v2, 'owner', 'WAIT_SIGNALS')
        self.assertEqual(self.store.control('weather-api')['state'], 'DISABLED')
        self.assertEqual(self.events('weather-api'), [])             # la transaction est atomique : aucun événement non plus

    def test_state_and_event_are_written_in_one_real_transaction(self):
        v1 = application('weather-api')
        self.store.configure(v1)
        self.store.pause(v1, False)
        self.assertTrue(self.store.acquire(v1, 'owner'))
        self.store.transition(v1, 'owner', 'WAIT_SIGNALS')
        self.assertEqual(self.store.control('weather-api')['state'], 'WAIT_SIGNALS')
        self.assertEqual([event['state'] for event in self.events('weather-api')], ['WAIT_SIGNALS'])

    def test_a_changed_configuration_blocks_the_worker_and_alerts_once_per_version(self):
        v1, v2, v3 = application('weather-api'), changed('weather-api', '10.189.0.4'), changed('weather-api', '10.189.0.5')
        self.store.configure(v1)
        self.store.pause(v1, False)
        worker = a.Worker(self.store, Mock(), Mock(), Mock())
        self.assertEqual(worker.run(v2), 'BLOCKED_CONFIG_CHANGED')
        self.assertEqual(worker.run(v2), 'BLOCKED_CONFIG_CHANGED')
        self.assertEqual([event['state'] for event in self.events('weather-api')], ['CONFIG_CHANGED'])      # une seule alerte
        self.store.notify_pending('weather-api')
        self.store.notify_pending('weather-api')
        self.assertEqual(self.sns.publish.call_count, 1)                                                     # une seule notification
        self.assertEqual(self.sns.publish.call_args.kwargs['Subject'],
                         'CNP failover - weather-api : Configuration modifiee sans nouvelle verification')
        self.assertEqual(worker.run(v3), 'BLOCKED_CONFIG_CHANGED')                                           # nouvelle version : nouvelle alerte
        self.assertEqual(len(self.events('weather-api')), 2)
        self.assertEqual(worker.signals.method_calls + worker.sql.method_calls + worker.routing.method_calls, [])   # aucune action
        self.assertEqual(self.store.control('weather-api')['state'], 'DISABLED')                              # l'état n'a pas bougé

    def test_the_whole_command_in_platform_mode_against_real_tables(self):
        env = {'CNP_CONFIG_TABLE': a.PLATFORM['config_table'], 'CNP_STATE_TABLE': a.PLATFORM['state_table'], 'CNP_NOTIFICATION_TOPIC': TOPIC}
        dynamodb = self.client

        def factory(service, region=a.REGION):
            return dynamodb if service == 'dynamodb' else self.sns if service == 'sns' else Mock()

        def command(*argv):
            out = io.StringIO()
            with patch.dict(os.environ, env), patch.object(a, 'aws_session', return_value=factory), patch('sys.stdout', out):
                code = a.main(list(argv))
            return code, [json.loads(line) for line in out.getvalue().splitlines() if line.startswith('{')]

        v1 = application('weather-api')
        self.publish_config(v1)
        self.publish_config(application('another-api'))
        self.assertEqual(command('configure', '--app', 'weather-api', '--execute')[0], 0)
        code, status = command('status', '--app', 'weather-api', '--execute')
        self.assertEqual((code, status[0]['config_hash']), (0, a.config_hash(v1)))
        self.assertEqual(command('configure', '--app', 'missing-api', '--execute')[0], 1)        # app absente de la table
        self.assertEqual(command('configure', '--execute')[0], 1)                                # écriture sans app explicite
        self.client.put_item(TableName=a.PLATFORM['config_table'], Item={'app': {'S': 'broken-api'}, 'config': {'S': 'not json'}})
        code, output = command('status', '--execute')                                           # une config invalide est signalée
        self.assertEqual(code, 1)
        self.assertIn({'app': 'broken-api', 'state': 'BLOCKED_INVALID_CONFIG'}, output)
        self.publish_config(changed('weather-api', '10.189.0.4'))                                # GitOps modifie la configuration
        self.client.delete_item(TableName=a.PLATFORM['config_table'], Key={'app': {'S': 'broken-api'}})
        code, output = command('run', '--app', 'weather-api', '--execute')
        self.assertEqual(code, 1)
        self.assertIn({'app': 'weather-api', 'state': 'BLOCKED_CONFIG_CHANGED'}, output)

    def promoted(self, value, fence='GCP_FENCED', paused=True, lease_until=None):
        """État laissé par une bascule réussie, le worker ensuite mis en pause par le portail."""
        values = {'app': value['app'], 'record': 'CONTROL', 'paused': paused, 'state': 'AWS_ACTIVE',
            'config_hash': a.config_hash(value), 'updated_at': 1, 'source_fence': fence}
        if lease_until is not None:
            values.update(lease_owner='other', lease_until=lease_until)
        self.client.put_item(TableName=a.PLATFORM['state_table'], Item=a.item(values))

    def test_failback_route_reopens_only_a_stopped_worker_whose_gcp_is_fenced(self):
        value = application('weather-api')
        sql, routing = Mock(), Mock()
        failback = a.Failback(self.store, sql, routing)
        refused = [dict(paused=False), dict(fence='GCP_FENCE_PENDING'), dict(lease_until=2 ** 40)]
        for state in refused:
            self.promoted(value, **state)
            with self.assertRaises(a.Blocked):
                failback.route(value)
        routing.set_closed.assert_not_called()
        with self.assertRaises(Exception):                                   # configure n'écrase jamais une bascule
            self.store.configure(value)
        self.client.delete_item(TableName=a.PLATFORM['state_table'], Key=self.store.key('weather-api'))
        self.store.configure(value)                                          # surveillance normale : pas de retour
        with self.assertRaisesRegex(a.Blocked, 'BLOCKED_FAILBACK_STATE'):
            failback.route(value)
        self.promoted(value)
        self.assertEqual(failback.route(value), 'GCP_ROUTE_REOPENED')
        routing.set_closed.assert_called_once_with(value, False)
        self.assertEqual([event['state'] for event in self.events('weather-api')], ['GCP_ROUTE_REOPENED'])
        self.assertEqual(self.store.control('weather-api')['state'], 'AWS_ACTIVE')     # l'état ne change pas

    def test_rearm_restarts_the_control_in_pause_after_the_standby_is_rebuilt(self):
        value = application('weather-api')
        sql = Mock()
        sql.connection.return_value.__enter__ = Mock(return_value='target')
        sql.connection.return_value.__exit__ = Mock(return_value=False)
        sql.saved_state.return_value = 'AWS_ACTIVE'                          # copie AWS pas encore remise à zéro
        failback = a.Failback(self.store, sql, Mock())
        self.promoted(value)
        with self.assertRaisesRegex(a.Blocked, 'BLOCKED_SQL_STATE'):
            failback.rearm(value)
        self.assertEqual(self.store.control('weather-api')['state'], 'AWS_ACTIVE')
        sql.saved_state.return_value = None
        sql.standby_ready.side_effect = a.Blocked('BLOCKED_REPLICATION')      # abonnement pas encore prêt
        with self.assertRaisesRegex(a.Blocked, 'BLOCKED_REPLICATION'):
            failback.rearm(value)
        sql.standby_ready.side_effect = None
        self.assertEqual(failback.rearm(value), 'DISABLED')
        control = self.store.control('weather-api')
        self.assertEqual((control['state'], control['paused'], control['config_hash']), ('DISABLED', True, a.config_hash(value)))
        self.assertNotIn('source_fence', control)
        self.assertFalse(self.store.acquire(value, 'owner'))                  # en pause jusqu'à worker-resume
        with self.assertRaisesRegex(a.Blocked, 'BLOCKED_FAILBACK_STATE'):     # rejouer ne réécrit rien
            failback.rearm(value)
        self.assertEqual([event['state'] for event in self.events('weather-api')], ['GCP_ACTIVE'])

    def test_rearm_condition_is_checked_by_dynamodb_not_only_by_the_prior_read(self):
        value = application('weather-api')
        self.promoted(value, lease_until=2 ** 40)                            # un worker a repris un bail entre-temps
        with self.assertRaisesRegex(a.Blocked, 'BLOCKED_FAILBACK_STATE'):
            self.store.rearm(value)
        self.assertEqual(self.store.control('weather-api')['state'], 'AWS_ACTIVE')
    def test_only_the_states_that_need_a_person_are_emailed_and_a_block_once_per_hour(self):
        put = lambda state, at: self.client.put_item(TableName=a.PLATFORM['state_table'], Item=a.item(
            {'app': 'weather-api', 'record': f'EVENT#{at:020d}#{state}', 'state': state, 'field': 'state', 'at': at, 'delivered': False}))
        for index, state in enumerate(['WAIT_SIGNALS', 'CLOSING_GCP_ROUTE', 'DISABLING_SUBSCRIPTION', 'OPENING_AWS', 'AWS_ACTIVE',
                                       'GCP_FENCE_PENDING', 'BLOCKED_OPERATION']):
            put(state, 1000 + index)
        put('BLOCKED_OPERATION', 1070)                     # même blocage une minute plus tard : pas de nouvel e-mail
        self.store.notify_pending('weather-api')
        subjects = [call.kwargs['Subject'] for call in self.sns.publish.call_args_list]
        self.assertEqual(len(subjects), 3)
        self.assertEqual(subjects[0], 'CNP failover - weather-api : Panne de GCP confirmee')
        self.assertEqual(subjects[1], 'CNP failover - weather-api : Bascule vers AWS terminee')
        self.assertEqual(subjects[2], 'CNP failover - weather-api : Worker bloque (BLOCKED_OPERATION)')
        self.assertTrue(all(subject.isascii() and len(subject) < 100 for subject in subjects))
        self.assertIn('Bascule vers AWS terminée', self.sns.publish.call_args_list[1].kwargs['Message'])     # accents dans le corps
        self.assertTrue(all(event['delivered'] for event in self.events('weather-api')))                  # journal complet, tout traité
        put('BLOCKED_OPERATION', 1006 + 3600)              # une heure plus tard : rappel
        self.store.notify_pending('weather-api')
        self.assertEqual(self.sns.publish.call_count, 4)

if __name__ == '__main__':
    unittest.main()
