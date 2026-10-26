import argparse
import base64
import importlib.util
import io
import json
import pathlib
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bootstrap_dev_domain', pathlib.Path(__file__).with_name('bootstrap-dev-domain.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class DevDomainBootstrapTests(unittest.TestCase):
    def setUp(self):
        cli = patch.object(module.shutil, 'which', return_value='/usr/bin/aws')
        cli.start()
        self.addCleanup(cli.stop)
        self.args = argparse.Namespace(apply=False, project='test-project', base_domain='apps.mooroon5.fr',
                                       zone='TESTZONE', lb_ip='34.54.71.90', aws_region='eu-west-3', certificate_map='existing-map')

    def test_read_only_plan_performs_no_mutations(self):
        calls = []

        def fake(command, payload=None):
            calls.append(command)
            return {'ResourceRecordSets': []} if command[0] == 'aws' else []

        with patch.object(module, 'run', side_effect=fake), redirect_stdout(io.StringIO()):
            module.bootstrap(self.args)
        self.assertEqual(len(calls), 4)
        self.assertFalse(any('create' in cmd or 'apply' in cmd for cmd in calls))

    def test_failover_records_are_never_adopted(self):
        record = {'Name': '*.dev.apps.mooroon5.fr.', 'Type': 'A', 'SetIdentifier': 'gcp-primary',
                  'Failover': 'PRIMARY', 'ResourceRecords': [{'Value': self.args.lb_ip}]}
        with self.assertRaisesRegex(ValueError, 'routing policy'):
            module.check_dns([record], '*.dev.apps.mooroon5.fr', 'A', self.args.lb_ip)

    def test_an_identical_unmanaged_record_is_preserved(self):
        record = {'Name': '\\052.dev.apps.mooroon5.fr.', 'Type': 'A', 'ResourceRecords': [{'Value': self.args.lb_ip}]}
        self.assertTrue(module.check_dns([record], '*.dev.apps.mooroon5.fr', 'A', self.args.lb_ip))

    def test_a_different_dns_target_is_rejected(self):
        record = {'Name': '*.dev.apps.mooroon5.fr.', 'Type': 'A', 'ResourceRecords': [{'Value': '1.2.3.4'}]}
        with self.assertRaisesRegex(ValueError, 'target'):
            module.check_dns([record], '*.dev.apps.mooroon5.fr', 'A', self.args.lb_ip)

    def test_generated_crossplane_record_never_overwrites_and_survives_accidental_prune(self):
        record = module.dns_record('dev-wildcard', '*.dev.apps.mooroon5.fr', 'A', self.args.lb_ip, self.args)
        self.assertEqual(record['spec']['deletionPolicy'], 'Orphan')
        self.assertFalse(record['spec']['forProvider']['allowOverwrite'])
        self.assertEqual(record['spec']['forProvider']['region'], 'eu-west-3')
        self.assertEqual(record['spec']['forProvider']['zoneId'], 'TESTZONE')

    def test_apply_only_adds_dev_resources_preserving_production(self):
        self.args.apply = True
        calls = []
        auth = {'name': 'projects/test/dnsAuthorizations/cnp-apps-dev-dns-auth', 'domain': 'dev.apps.mooroon5.fr',
                'dnsResourceRecord': {'name': '_acme-challenge_dev.dev.apps.mooroon5.fr.', 'type': 'CNAME', 'data': 'auth.example.org.'}}
        production = {'Name': '*.apps.mooroon5.fr.', 'Type': 'A', 'SetIdentifier': 'primary', 'Failover': 'PRIMARY'}

        def fake(command, payload=None):
            calls.append((command, payload))
            if command[0] == 'aws':
                return {'ResourceRecordSets': [production]}
            if 'list' in command:
                return []
            if 'dns-authorizations' in command and 'create' in command:
                return auth
            return {}

        with patch.object(module, 'run', side_effect=fake), redirect_stdout(io.StringIO()):
            module.bootstrap(self.args)
        manifests = json.loads(next(payload for command, payload in calls if command[0] == 'kubectl'))['items']
        self.assertEqual({item['spec']['forProvider']['name'] for item in manifests},
                         {'*.dev.apps.mooroon5.fr', '_acme-challenge_dev.dev.apps.mooroon5.fr'})
        entry_command = next(command for command, _ in calls if 'entries' in command and 'create' in command)
        self.assertIn('*.dev.apps.mooroon5.fr', entry_command)
        self.assertIn('existing-map', entry_command)
        self.assertFalse(any('update' in command or 'delete' in command for command, _ in calls))

    def test_xml_parser_preserves_failover_and_pagination(self):
        xml = b'''<ListResourceRecordSetsResponse xmlns="https://route53.amazonaws.com/doc/2013-04-01/">
        <ResourceRecordSets><ResourceRecordSet><Name>app.apps.mooroon5.fr.</Name><Type>A</Type>
        <SetIdentifier>primary</SetIdentifier><Failover>PRIMARY</Failover><HealthCheckId>hc</HealthCheckId>
        <ResourceRecords><ResourceRecord><Value>34.54.71.90</Value></ResourceRecord></ResourceRecords>
        </ResourceRecordSet></ResourceRecordSets><IsTruncated>true</IsTruncated>
        <NextRecordName>next.apps.mooroon5.fr.</NextRecordName><NextRecordType>A</NextRecordType>
        <NextRecordIdentifier>secondary</NextRecordIdentifier></ListResourceRecordSetsResponse>'''
        records, page = module.parse_recordsets(xml)
        self.assertEqual(records[0]['Failover'], 'PRIMARY')
        self.assertEqual(records[0]['HealthCheckId'], 'hc')
        self.assertEqual(records[0]['ResourceRecords'], [{'Value': '34.54.71.90'}])
        self.assertEqual(page['identifier'], 'secondary')
        with self.assertRaisesRegex(ValueError, 'routing policy'):
            module.check_dns(records, 'app.apps.mooroon5.fr', 'A', '34.54.71.90')

    def test_stdlib_route53_fallback_fetches_only_selected_zone_and_all_pages(self):
        with patch.object(module.shutil, 'which', return_value=None), \
                patch.object(module, 'aws_credentials', return_value=('test-access', 'test-secret', None)), \
                patch.object(module, 'route53_request', side_effect=[b'first', b'second']) as request, \
                patch.object(module, 'parse_recordsets', side_effect=[([{'Name': 'first'}], {'name': 'next', 'type': 'A'}), ([{'Name': 'second'}], None)]):
            self.assertEqual(len(module.list_dns_records('ONLYZONE')), 2)
        self.assertTrue(all(call.args[0] == 'ONLYZONE' for call in request.call_args_list))

    def test_malformed_secret_errors_never_expose_credential_contents(self):
        provider = {'spec': {'credentials': {'source': 'Secret', 'secretRef': {'key': 'creds', 'name': 'aws-creds', 'namespace': 'crossplane-system'}}}}
        secret = {'data': {'creds': base64.b64encode(b'private-value-without-ini-header').decode()}}
        with patch.dict(module.os.environ, {}, clear=True), patch.object(module, 'run', side_effect=[provider, secret]):
            with self.assertRaises(ValueError) as raised:
                module.aws_credentials()
        self.assertNotIn('private-value', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
