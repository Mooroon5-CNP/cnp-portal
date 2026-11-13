#!/usr/bin/env python3
"""Prepare/apply the dev wildcard without replacing production DNS or certificates."""

import argparse
import base64
import configparser
import datetime
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def run(command, payload=None):
    result = subprocess.run(command, input=payload, text=True, capture_output=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else {}


def aws_credentials():
    if os.environ.get('AWS_ACCESS_KEY_ID') and os.environ.get('AWS_SECRET_ACCESS_KEY'):
        return os.environ['AWS_ACCESS_KEY_ID'], os.environ['AWS_SECRET_ACCESS_KEY'], os.environ.get('AWS_SESSION_TOKEN')
    provider = run(['kubectl', 'get', 'providerconfig.aws.upbound.io', 'default', '-o', 'json'])
    credentials = provider['spec']['credentials']
    if credentials.get('source') != 'Secret':
        raise ValueError('AWS environment credentials or a Secret-backed default ProviderConfig are required')
    reference = credentials['secretRef']
    secret = run(['kubectl', 'get', 'secret', reference['name'], '-n', reference['namespace'], '-o', 'json'])
    try:
        content = base64.b64decode(secret['data'][reference['key']]).decode()
        config = configparser.ConfigParser()
        config.read_string(content)
        profile = config['default']
        return profile['aws_access_key_id'].strip(), profile['aws_secret_access_key'].strip(), profile.get('aws_session_token')
    except (ValueError, KeyError, UnicodeError, configparser.Error):
        raise ValueError('AWS provider credentials are not a valid default INI profile') from None


def route53_request(zone, query, credentials):
    access_key, secret_key, token = credentials
    now = datetime.datetime.now(datetime.timezone.utc)
    timestamp, date = now.strftime('%Y%m%dT%H%M%SZ'), now.strftime('%Y%m%d')
    host = 'route53.amazonaws.com'
    path = '/2013-04-01/hostedzone/' + urllib.parse.quote(zone.removeprefix('/hostedzone/'), safe='') + '/rrset'
    query_string = urllib.parse.urlencode(sorted(query.items()), quote_via=urllib.parse.quote, safe='~')
    headers = {'host': host, 'x-amz-date': timestamp}
    if token:
        headers['x-amz-security-token'] = token
    signed_headers = ';'.join(sorted(headers))
    canonical_headers = ''.join(f'{key}:{headers[key]}\n' for key in sorted(headers))
    canonical = '\n'.join(['GET', path, query_string, canonical_headers, signed_headers, hashlib.sha256(b'').hexdigest()])
    scope = date + '/us-east-1/route53/aws4_request'
    to_sign = '\n'.join(['AWS4-HMAC-SHA256', timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = ('AWS4' + secret_key).encode()
    for part in (date, 'us-east-1', 'route53', 'aws4_request'):
        key = hmac.new(key, part.encode(), hashlib.sha256).digest()
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    headers['Authorization'] = f'AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}'
    request = urllib.request.Request('https://' + host + path + '?' + query_string, headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def parse_recordsets(payload):
    root = ET.fromstring(payload)
    for item in root.iter():
        item.tag = item.tag.split('}')[-1]
    records = []
    for element in root.findall('./ResourceRecordSets/ResourceRecordSet'):
        record = {}
        for item in element:
            if item.tag == 'ResourceRecords':
                record[item.tag] = [{'Value': child.findtext('Value')} for child in item]
            elif list(item):
                record[item.tag] = {child.tag: child.text for child in item}
            else:
                record[item.tag] = item.text
        records.append(record)
    next_page = None
    if root.findtext('IsTruncated') == 'true':
        next_page = {'name': root.findtext('NextRecordName'), 'type': root.findtext('NextRecordType')}
        if root.findtext('NextRecordIdentifier'):
            next_page['identifier'] = root.findtext('NextRecordIdentifier')
    return records, next_page


def list_dns_records(zone):
    if shutil.which('aws'):
        return run(['aws', 'route53', 'list-resource-record-sets', '--hosted-zone-id', zone, '--output', 'json'])['ResourceRecordSets']
    credentials = aws_credentials()
    records, query = [], {}
    while query is not None:
        page, query = parse_recordsets(route53_request(zone, query, credentials))
        records.extend(page)
    return records


def check_dns(records, name, kind, value):
    """Never adopt or overwrite an existing Route53 policy or a different target."""
    normalized = name.rstrip('.').lower()
    for record in records:
        if record['Name'].rstrip('.').lower().replace('\\052', '*') != normalized:
            continue
        if record['Type'] != kind:
            raise ValueError(f'Conflicting DNS type exists for {name}')
        if any(key in record for key in ('SetIdentifier', 'Failover', 'AliasTarget', 'HealthCheckId', 'Weight', 'Region', 'GeoLocation', 'MultiValueAnswer')):
            raise ValueError(f'Existing routing policy must remain untouched: {name}')
        values = [item['Value'].rstrip('.') for item in record.get('ResourceRecords', [])]
        if values != [value.rstrip('.')]:
            raise ValueError(f'Existing DNS target must remain untouched: {name}')
        return True
    return False


def dns_record(identifier, name, kind, value, args):
    return {'apiVersion': 'route53.aws.upbound.io/v1beta2', 'kind': 'Record',
            'metadata': {'name': identifier, 'labels': {'cnp.io/environment': 'dev', 'cnp.io/component': 'applications-domain'}},
            'spec': {'deletionPolicy': 'Orphan', 'forProvider': {
                'region': args.aws_region, 'zoneId': args.zone, 'name': name.rstrip('.'),
                'type': kind, 'ttl': 300, 'records': [value], 'allowOverwrite': False,
            }, 'providerConfigRef': {'name': 'default'}}}


def bootstrap(args):
    project = ['--project', args.project, '--format=json', '--quiet']
    gcloud = ['gcloud', 'certificate-manager']
    domain = 'dev.' + args.base_domain
    wildcard = '*.' + domain
    auth_id, cert_id, entry_id = 'cnp-apps-dev-dns-auth', 'cnp-apps-dev-wildcard', 'cnp-apps-dev-certmap-entry'
    # Inspect all existing resources before creating anything.
    auths = run(gcloud + ['dns-authorizations', 'list'] + project)
    certs = run(gcloud + ['certificates', 'list'] + project)
    entries = run(gcloud + ['maps', 'entries', 'list', '--map', args.certificate_map] + project)
    records = list_dns_records(args.zone)
    auth = next((item for item in auths if item['name'].endswith('/' + auth_id)), None)
    cert = next((item for item in certs if item['name'].endswith('/' + cert_id)), None)
    entry = next((item for item in entries if item['name'].endswith('/' + entry_id)), None)
    if auth and auth.get('domain') != domain:
        raise ValueError('Existing dev DNS authorization has a different domain')
    if cert and (cert.get('managed', {}).get('domains') != [wildcard] or not any(item.endswith('/' + auth_id) for item in cert.get('managed', {}).get('dnsAuthorizations', []))):
        raise ValueError('Existing dev certificate has different authorization or domains')
    if entry and (entry.get('hostname') != wildcard or not any(item.endswith('/' + cert_id) for item in entry.get('certificates', []))):
        raise ValueError('Existing dev certificate map entry has different routing')
    wildcard_exists = check_dns(records, wildcard, 'A', args.lb_ip)
    if auth:
        rr = auth['dnsResourceRecord']
        check_dns(records, rr['name'], rr['type'], rr['data'])
    print(json.dumps({'apply': args.apply, 'domain': wildcard, 'loadBalancerIp': args.lb_ip,
                      'dnsAuthorization': auth_id, 'certificate': cert_id, 'certificateMap': args.certificate_map,
                      'existingWildcard': wildcard_exists,
                      'preserves': ['production certificates and map entries', 'production Route53 failover records', 'portal hosting']}, indent=2))
    if not args.apply:
        return
    if not auth:
        auth = run(gcloud + ['dns-authorizations', 'create', auth_id, '--domain', domain, '--type', 'PER_PROJECT_RECORD'] + project)
    rr = auth['dnsResourceRecord']
    authorization_exists = check_dns(records, rr['name'], rr['type'], rr['data'])
    resources = []
    # Existing identical DNS stays with its existing owner; do not adopt it.
    if not authorization_exists:
        resources.append(dns_record('cnp-apps-dev-certificate-auth', rr['name'], rr['type'], rr['data'], args))
    if not wildcard_exists:
        resources.append(dns_record('cnp-apps-dev-wildcard', wildcard, 'A', args.lb_ip, args))
    if resources:
        run(['kubectl', 'apply', '-f', '-', '-o', 'json'], json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': resources}))
    if not cert:
        run(gcloud + ['certificates', 'create', cert_id, '--domains', wildcard, '--dns-authorizations', auth_id] + project)
    if not entry:
        run(gcloud + ['maps', 'entries', 'create', entry_id, '--map', args.certificate_map, '--hostname', wildcard, '--certificates', cert_id] + project)
    print('Dev wildcard configured. Wait for the certificate to become ACTIVE before enabling friendly links.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Create missing dev resources; default is read-only inspection')
    parser.add_argument('--project', default='cnp-terraform-512313')
    parser.add_argument('--base-domain', default='apps.mooroon5.fr')
    parser.add_argument('--zone', default='Z03070463OHUIPXFTWDYQ')
    parser.add_argument('--lb-ip', default='34.54.71.90')
    parser.add_argument('--aws-region', default='eu-west-3')
    parser.add_argument('--certificate-map', default='cnp-apps-certmap')
    bootstrap(parser.parse_args())


if __name__ == '__main__':
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f'Dev domain bootstrap failed: {error}', file=sys.stderr)
        sys.exit(1)
