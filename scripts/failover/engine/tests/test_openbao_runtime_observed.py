import importlib.util
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location('operate', Path(__file__).parents[2] / 'operate.py')
operate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operate)


class TestObservedRuntimeVariables(unittest.TestCase):
    def test_versions_and_removed_names_must_match_on_both_clouds(self):
        gcp = {'name': 'FEATURE', 'valueSource': {'secretKeyRef': {'secret': 'cnp-feature', 'version': '7'}}}
        aws = {'name': 'FEATURE', 'valueFrom': 'arn:aws:secretsmanager:eu-west-3:123456789012:secret:feature:::version'}
        expected = {'gcp': [gcp], 'aws': [aws], 'ownedNames': ['FEATURE', 'OLD']}
        cloudrun = {'template': {'containers': [{'env': [gcp]}]}}
        containers = [{'secrets': [aws]}]
        self.assertTrue(operate.runtime_variables_match(expected, cloudrun, containers))
        self.assertTrue(operate.aws_runtime_variables_match(expected, containers))
        self.assertFalse(operate.aws_runtime_variables_match(expected,
            [{'secrets': [{**aws, 'valueFrom': aws['valueFrom'] + '-old'}]}]))
        self.assertFalse(operate.runtime_variables_match(expected, cloudrun,
            [{'secrets': [{**aws, 'valueFrom': aws['valueFrom'] + '-old'}]}]))
        self.assertFalse(operate.runtime_variables_match(expected,
            {'template': {'containers': [{'env': [gcp, {'name': 'OLD'}]}]}}, containers))
        self.assertFalse(operate.runtime_variables_match(expected,
            {'template': {'containers': [{'env': [{**gcp, 'valueSource': {'secretKeyRef': {'secret': 'cnp-feature', 'version': '6'}}}]}]}}, containers))

    def test_task_must_use_the_application_execution_role(self):
        role = 'arn:aws:iam::123456789012:role/cnp-runtime/cnp-' + 'a' * 20 + '-exec'
        expected = {'gcp': [], 'aws': [], 'ownedNames': [], 'aws_execution_role': role}
        self.assertTrue(operate.aws_execution_role_match(expected, role))
        self.assertFalse(operate.aws_execution_role_match(expected, 'arn:aws:iam::123456789012:role/ecs-execution-role'))
        self.assertFalse(operate.aws_execution_role_match(expected, None))
        # Publication sans variable : pas d'exigence de rôle propre.
        self.assertTrue(operate.aws_execution_role_match({'gcp': [], 'aws': [], 'ownedNames': []}, 'anything'))


if __name__ == '__main__':
    unittest.main()
