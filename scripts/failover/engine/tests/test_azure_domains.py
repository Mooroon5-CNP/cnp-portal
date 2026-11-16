import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import azure_domains  # noqa: E402

RG = 'https://arm/rg'
CERTS = RG + '/providers/Microsoft.App/managedEnvironments/cae/managedCertificates'
APPS = RG + '/providers/Microsoft.App/containerApps'


def app(name, env, domains=None, extra_tags=None):
    return {'name': name, 'location': 'France Central', 'tags': {'cnp-env': env, **(extra_tags or {})},
            'properties': {'configuration': {'ingress': {'external': True, 'targetPort': 8080,
                                                         'fqdn': name + '.default.example',
                                                         'customDomains': domains}}}}


class FakeArm:
    def __init__(self, apps, certs=()):
        self.apps, self.certs, self.calls = apps, list(certs), []

    def __call__(self, method, url, body=None):
        path = url.split('?')[0]
        self.calls.append((method, path, body))
        if method == 'GET' and path == APPS:
            return {'value': self.apps}
        if method == 'GET' and path == CERTS:
            return {'value': self.certs}
        return {}

    def writes(self):
        return [(m, p.rsplit('/', 1)[-1], b) for m, p, b in self.calls if m != 'GET']


def domains(arm):
    return azure_domains.Domains(arm, RG, 'cae', 'eu.example', log=lambda line: None)


class DomainsTest(unittest.TestCase):
    def test_hostnames(self):
        self.assertEqual(azure_domains.hostname('todo', 'prod', 'eu.example'), 'todo.eu.example')
        self.assertEqual(azure_domains.hostname('todo', 'dev', 'eu.example'), 'todo-dev.eu.example')

    def test_only_portal_apps_are_considered(self):
        self.assertEqual(azure_domains.app_and_env(app('todo-prod', 'prod')), ('todo', 'prod'))
        self.assertEqual(azure_domains.app_and_env(app('my-app-dev', 'dev')), ('my-app', 'dev'))
        self.assertEqual(azure_domains.app_and_env(app('x-prod', 'prod', extra_tags={'cnp-app': 'y'})), ('y', 'prod'))
        self.assertIsNone(azure_domains.app_and_env(app('legacy', 'prod')))
        self.assertIsNone(azure_domains.app_and_env({'name': 'job', 'tags': {}}))

    def test_first_pass_adds_the_name_unbound_keeping_the_whole_ingress(self):
        arm = FakeArm([app('todo-prod', 'prod')])
        self.assertEqual(domains(arm).reconcile()[0]['state'], 'NAME_ADDED')
        [(method, name, body)] = arm.writes()
        ingress = body['properties']['configuration']['ingress']
        self.assertEqual((method, name), ('PATCH', 'todo-prod'))
        self.assertEqual(ingress['customDomains'], [{'name': 'todo.eu.example', 'bindingType': 'Disabled'}])
        self.assertEqual((ingress['external'], ingress['targetPort']), (True, 8080))
        self.assertNotIn('fqdn', ingress)

    def test_second_pass_requests_a_managed_certificate(self):
        arm = FakeArm([app('todo-dev', 'dev', [{'name': 'todo-dev.eu.example', 'bindingType': 'Disabled'}])])
        self.assertEqual(domains(arm).reconcile()[0]['state'], 'CERTIFICATE_REQUESTED')
        [(method, name, body)] = arm.writes()
        self.assertEqual((method, name), ('PUT', 'cnp-todo-dev-eu-example'))
        self.assertEqual(body['properties'], {'subjectName': 'todo-dev.eu.example', 'domainControlValidation': 'HTTP'})

    def test_waits_for_the_certificate_then_binds_it(self):
        pending = {'name': 'c', 'id': '/certs/c', 'properties': {'subjectName': 'todo.eu.example', 'provisioningState': 'Pending'}}
        arm = FakeArm([app('todo-prod', 'prod', [{'name': 'todo.eu.example', 'bindingType': 'Disabled'}])], [pending])
        self.assertEqual(domains(arm).reconcile()[0]['state'], 'CERTIFICATE_PENDING')
        self.assertEqual(arm.writes(), [])
        pending['properties']['provisioningState'] = 'Succeeded'
        self.assertEqual(domains(arm).reconcile()[0]['state'], 'BOUND_NOW')
        [(_, _, body)] = arm.writes()
        self.assertEqual(body['properties']['configuration']['ingress']['customDomains'],
                         [{'name': 'todo.eu.example', 'bindingType': 'SniEnabled', 'certificateId': '/certs/c'}])

    def test_an_existing_certificate_is_reused_whatever_its_name(self):
        manual = {'name': 'mc-manual', 'id': '/certs/mc', 'properties': {'subjectName': 'todo-dev.eu.example', 'provisioningState': 'Succeeded'}}
        arm = FakeArm([app('todo-dev', 'dev', [{'name': 'todo-dev.eu.example', 'bindingType': 'Disabled'}])], [manual])
        self.assertEqual(domains(arm).reconcile()[0]['state'], 'BOUND_NOW')

    def test_bound_apps_are_left_alone(self):
        arm = FakeArm([app('todo-prod', 'prod', [{'name': 'todo.eu.example', 'bindingType': 'SniEnabled', 'certificateId': '/c'}])])
        self.assertEqual(domains(arm).reconcile()[0]['state'], 'BOUND')
        self.assertEqual(arm.writes(), [])

    def test_certificates_of_deleted_apps_are_removed_but_not_foreign_ones(self):
        orphan = {'name': 'old', 'properties': {'subjectName': 'gone.eu.example'}}
        foreign = {'name': 'other', 'properties': {'subjectName': 'www.autre.example'}}
        arm = FakeArm([], [orphan, foreign])
        self.assertEqual([r['state'] for r in domains(arm).reconcile()], ['CERTIFICATE_REMOVED'])
        self.assertEqual(arm.writes(), [('DELETE', 'old', None)])

    def test_status_writes_nothing(self):
        orphan = {'name': 'old', 'properties': {'subjectName': 'gone.eu.example'}}
        arm = FakeArm([app('todo-prod', 'prod')], [orphan])
        states = [r['state'] for r in domains(arm).reconcile(apply=False)]
        self.assertEqual(states, ['PENDING', 'CERTIFICATE_ORPHAN'])
        self.assertEqual(arm.writes(), [])

    def test_one_failing_app_does_not_stop_the_others(self):
        arm = FakeArm([app('a-prod', 'prod'), app('b-prod', 'prod')])
        original = arm.__call__

        def flaky(method, url, body=None):
            if method == 'PATCH' and url.split('?')[0].endswith('/a-prod'):
                raise RuntimeError('HTTP 409')
            return original(method, url, body)
        states = [r['state'] for r in domains(flaky).reconcile()]
        self.assertEqual(states, ['ERROR', 'NAME_ADDED'])


if __name__ == '__main__':
    unittest.main()
