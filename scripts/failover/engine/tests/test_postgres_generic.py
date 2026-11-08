"""Le profil PostgreSQL générique ne doit rien devoir à Pixelcalm : mêmes garanties de standby, messages neutres."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import render_aws_prod_example as aws
from test_aws_prod_example import profile, observation


class PostgresGenericTests(unittest.TestCase):
    def config(self, application_profile='postgres'):
        c = profile()
        c.update(application_profile=application_profile, runtime_user='cnp_runtime',
                 runtime_secret_arn=f'arn:aws:secretsmanager:{aws.REGION}:{aws.ACCOUNT}:secret:cnp/failover/{c["app_name"]}/runtime-fixture',
                 database_ca_pem=(Path(__file__).parent / 'fixtures/public-test-ca.pem').read_text())
        if application_profile == 'postgres':
            c.update(database_name='appdb', sql_contract={'database': 'appdb'})
        return c

    def probe(self, c):
        return aws.runtime(c, observation())['alb-target-group.yaml']['spec']['forProvider']['healthCheck']

    def test_postgres_standby_is_probed_for_liveness_not_for_database(self):
        # Le standby garde le rôle runtime NOLOGIN : /health vaut 503 avant promotion, ECS ne doit pas tuer la tâche.
        self.assertEqual(self.probe(self.config()), [{'path': '/healthz', 'matcher': '200', 'interval': 10, 'healthyThreshold': 2, 'timeout': 5}])

    def test_explicit_liveness_path_wins(self):
        c = self.config()
        c['liveness_path'] = '/vie'
        self.assertEqual(self.probe(c)[0]['path'], '/vie')

    def test_postgres_runtime_keeps_the_closable_role_and_verified_ca(self):
        for field, value in [('runtime_user', 'another_writer'), ('database_ca_pem', None)]:
            invalid = deepcopy(self.config())
            invalid[field] = value
            with self.assertRaises(ValueError):
                aws.runtime(invalid, observation())

    def test_errors_do_not_name_an_application(self):
        invalid = self.config()
        invalid['runtime_user'] = 'another_writer'
        with self.assertRaises(ValueError) as caught:
            aws.runtime(invalid, observation())
        self.assertIn('PostgreSQL', str(caught.exception))
        self.assertNotRegex(str(caught.exception), '(?i)pixelcalm')
        invalid = self.config()
        invalid['database_ca_pem'] = None
        with self.assertRaises(ValueError) as caught:
            aws.runtime(invalid, observation())
        self.assertNotRegex(str(caught.exception), '(?i)pixelcalm')

    def test_a_profile_reduced_to_the_database_name_is_accepted(self):
        # Le schéma est lu dans la base de l'application : le profil ne porte plus que son nom.
        c = self.config()
        c['sql_contract'] = {'database': 'appdb'}
        self.assertEqual(self.probe(c), [{'path': '/healthz', 'matcher': '200', 'interval': 10, 'healthyThreshold': 2, 'timeout': 5}])
        c['sql_contract'] = {'database': 'autre'}
        with self.assertRaisesRegex(ValueError, 'Base différente'):
            aws.runtime(c, observation())

    def test_env_exposes_the_postgres_engine(self):
        task = aws.runtime(self.config(), observation())['ecs-task-definition.yaml']
        env = {x['name']: x['value'] for x in json.loads(task['spec']['forProvider']['containerDefinitions'])[0]['environment']}
        self.assertEqual(env['DB_ENGINE'], 'postgres')
        self.assertEqual(env['DB_SSLMODE'], 'verify-full')
        self.assertIn('DB_SSLROOTCERT_PEM', env)


if __name__ == '__main__':
    unittest.main()
