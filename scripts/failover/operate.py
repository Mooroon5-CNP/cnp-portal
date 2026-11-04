#!/usr/bin/env python3
"""Exécution opérateur bornée de phase 1 ; entrée/sortie JSON sans secret."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3] / 'cnp' / 'deployment' / 'failover-phase1'
sys.path.insert(0, str(ROOT))
import safe_apply


def command(args, directory=None):
    result = subprocess.run(args, cwd=directory, capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise ValueError('Commande opérateur refusée ; consulter les prérequis et reprendre après vérification.')
    return result.stdout


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def execute(request):
    action, app = request['action'], request['app']
    import re
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,38}[a-z0-9]', app):
        raise ValueError('Application invalide')
    document = request['document']
    if document['profile']['gcp']['app_name'] != app or document['profile']['aws']['app_name'] != app:
        raise ValueError('Identité du profil différente')
    work = Path(request['work']).resolve()
    expected = Path(__file__).resolve().parents[2] / 'data' / 'failover-operations'
    if expected.resolve() not in work.parents:
        raise ValueError('Dossier opérateur hors périmètre')
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    if action == 'health':
        import boto3, urllib.request
        from botocore.config import Config
        client = lambda name, region='eu-west-3': boto3.client(name, region_name=region, config=Config(connect_timeout=3, read_timeout=5, retries={'max_attempts': 0}))
        if client('sts').get_caller_identity()['Account'] != '804210702561': raise ValueError('Compte AWS inattendu')
        try:
            with urllib.request.urlopen('https://' + app + '.apps.mooroon5.fr' + document['profile']['gcp'].get('readiness_path', '/health'), timeout=10) as response:
                public_ready = response.status == 200
        except Exception: public_ready = False
        services = client('ecs').describe_services(cluster=document['profile'].get('automation', {}).get('ecs_cluster_arn', 'cnp-cluster'), services=[app + '-prod'])['services']
        aws_ready = len(services) == 1 and services[0]['runningCount'] >= 1 and services[0]['pendingCount'] == 0
        if document['profile'].get('mode') == 'stateless':
            return {'verified': public_ready and aws_ready, 'public_ready': public_ready, 'aws_ready': aws_ready, 'observed_at': int(time.time()), 'state': 'STATELESS'}
        def decode(item):
            return {key: value.get('S') if 'S' in value else value.get('BOOL') if 'BOOL' in value else int(value['N']) for key, value in item.items()}
        records = {}
        for name in ['CONTROL', 'REPLICATION']:
            records[name] = decode(client('dynamodb').get_item(TableName='cnp-failover-automation', Key={'app': {'S': app}, 'record': {'S': name}}, ConsistentRead=True).get('Item', {}))
        control, replication = records['CONTROL'], records['REPLICATION']
        fresh = 0 <= int(time.time()) - replication.get('observed_at', 0) <= 120 and 0 <= int(time.time()) - replication.get('last_message_at', 0) <= 120
        configured = bool(control.get('config_hash')) and control.get('config_hash') == replication.get('config_hash')
        healthy = control.get('paused') is False and (control.get('state') == 'AWS_ACTIVE' or (control.get('state') == 'WAIT_SIGNALS' and fresh and configured))
        return {'verified': healthy and public_ready and aws_ready, 'public_ready': public_ready, 'aws_ready': aws_ready,
            'state': control.get('state', 'UNCONFIGURED'), 'paused': control.get('paused'), 'replication_fresh': fresh,
            'observed_at': int(time.time()), 'zero_loss_proven': False}
    if action == 'allocate-listener':
        import boto3
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from render_aws_prod_example import PLATFORM
        client = boto3.client('elbv2', region_name='eu-west-3')
        used = set(request.get('used_priorities', []))
        for page in client.get_paginator('describe_rules').paginate(ListenerArn=PLATFORM['https_listener']):
            used.update(int(rule['Priority']) for rule in page['Rules'] if rule['Priority'].isdigit())
        return {'priority': next(value for value in range(20000, 50001) if value not in used)}
    if action in {'credentials-plan', 'automation-plan'}:
        stack = action.split('-')[0]
        source = ROOT / stack
        target = work / stack
        target.mkdir(exist_ok=True, mode=0o700)
        for file in source.glob('*.tf'):
            shutil.copyfile(file, target / file.name)
        lock = source / '.terraform.lock.hcl'
        if lock.exists(): shutil.copyfile(lock, target / lock.name)
        if stack == 'credentials':
            if document['secrets'].get('initialized'):
                return {'safe': True, 'changes': [], 'already_initialized': True}
            variables = {'prepare_credentials': True, 'app_name': app,
                'gcp_runtime_service_account': document['profile']['gcp']['gcp_runtime']['service_account']}
            key = f'aws/failover-credentials/{app}/terraform.tfstate'
        else:
            variables = request['variables']
            # Un état partagé est relu avec TOUS ses varfiles approuvés.
            # Ne jamais substituer une application au worker actif.
            key = 'aws/failover-automation/terraform.tfstate'
        command(['terraform', 'init', '-input=false', '-reconfigure', '-backend-config=key=' + key], target)
        if stack == 'automation':
            outputs = json.loads(command(['terraform', 'output', '-json'], target))
            value = lambda key, default: outputs.get(key, {}).get('value', default)
            variables['worker_versions'] = value('worker_version_definitions', {})
            variables['bootstrap_versions'] = value('bootstrap_version_definitions', {})
            variables['additional_applications'] = value('additional_applications', [])
            variables['active_worker_version'] = value('active_worker_version', '')
            image = request['images']['bootstrap']
            version = hashlib.sha256(image.encode()).hexdigest()
            variables['bootstrap_versions'][version] = image
            refs = document['credentials']['aws_secret_arns']
            refs = refs.get('value', refs)
            master = document['observations']['rds']['status']['atProvider']['masterUserSecret']
            master = master[0] if isinstance(master, list) else master
            variables['bootstrap_secret_arns'] = sorted(set(variables['bootstrap_secret_arns'] + list(refs.values()) + [master['secretArn']]))
            if request['kind'] != 'bootstrap-plan':
                worker = request['packages']['worker-config.json']
                legacy = {value['app'] for value in variables['applications']}
                variables['additional_applications'] = [value for value in worker['applications'] if value['app'] not in legacy]
                image = request['images']['worker']
                config = json.dumps(worker, sort_keys=True, separators=(',', ':'))
                version = hashlib.sha256((image + config).encode()).hexdigest()
                variables['worker_versions'][version] = {'image': image, 'config': config}
                if request['kind'] == 'activation-plan': variables['active_worker_version'] = version
        (target / 'operation.tfvars.json').write_text(json.dumps(variables))
        plan = target / 'reviewed.tfplan'
        command(['terraform', 'plan', '-input=false', '-out=' + str(plan), '-var-file=operation.tfvars.json'], target)
        rendered = json.loads(command(['terraform', 'show', '-json', str(plan)], target))
        review = safe_apply.inspect(rendered, stack)
        seal = {'stack': stack, 'plan': digest(plan), 'configuration': {file.name: digest(file) for file in target.glob('*.tf*') if file.name != 'terraform.tfstate'}}
        if stack == 'automation':
            seal['bootstrap_version'] = hashlib.sha256(request['images']['bootstrap'].encode()).hexdigest()
            if request['kind'] != 'bootstrap-plan': seal['worker_version'] = version
        (work / 'seal.json').write_text(json.dumps(seal))
        return review
    if action == 'apply':
        seal = json.loads((work / 'seal.json').read_text())
        target = work / seal['stack']
        plan = target / 'reviewed.tfplan'
        if digest(plan) != seal['plan'] or any(digest(target / name) != value for name, value in seal['configuration'].items()):
            raise ValueError('Plan ou configuration modifiés depuis la revue')
        review = safe_apply.inspect(json.loads(command(['terraform', 'show', '-json', str(plan)], target)), seal['stack'])
        if not review['safe']: raise ValueError('Destruction, remplacement ou changement hors phase 1 interdit')
        command(['terraform', 'apply', '-input=false', str(plan)], target)
        result = {'applied': True, 'review': review}
        if seal['stack'] == 'automation':
            result['outputs'] = json.loads(command(['terraform', 'output', '-json'], target))
            result['bootstrap_task_definition'] = result['outputs']['bootstrap_version_task_arns']['value'][seal['bootstrap_version']]
            if seal.get('worker_version'): result['worker_task_definition'] = result['outputs']['worker_version_task_arns']['value'][seal['worker_version']]
        if seal['stack'] == 'credentials': result['credentials'] = json.loads(command(['terraform', 'output', '-json'], target))
        return result
    if action == 'initialize-secrets':
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from prepare_failover_phase1 import credentials_profile
        import initialize_secrets
        import boto3
        client = boto3.client('sts', region_name='eu-west-3')
        if client.get_caller_identity()['Account'] != '804210702561': raise ValueError('Compte AWS inattendu')
        config = credentials_profile(document['profile'], document['credentials'])
        return {'secrets': initialize_secrets.initialize(config, boto3.client('secretsmanager', region_name='eu-west-3'))}
    if action == 'observe':
        context = document['profile']['automation']['kube_context']
        import initialize_secrets
        # Le validateur partagé vérifie aussi le contexte GKE autorisé.
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from prepare_failover_phase1 import credentials_profile
        initialize_secrets.validate(credentials_profile(document['profile'], document['credentials']))
        objects = {}
        for key, resource, name in [('cloudsql', 'databaseinstances.sql.gcp.upbound.io', app + '-prod-gcp-db'),
                ('rds', 'instances.rds.aws.upbound.io', app + '-prod-db'),
                ('healthcheck', 'healthchecks.route53.aws.upbound.io', app + '-failover'),
                ('routing_latch', 'healthchecks.route53.aws.upbound.io', app + '-failover-latch-http'),
                ('primary_healthcheck', 'healthchecks.route53.aws.upbound.io', app + '-failover-primary-health')]:
            result = subprocess.run(['kubectl', '--context', context, 'get', resource, name, '-o', 'json'], capture_output=True, text=True, timeout=30)
            if result.returncode == 0: objects[key] = json.loads(result.stdout)
            elif key in {'cloudsql', 'rds'}: raise ValueError('Bases absentes ou inaccessibles')
        instance = json.loads(command(['gcloud', 'sql', 'instances', 'describe', app + '-prod-gcp-db', '--project=cnp-terraform-512313', '--format=json']))
        return {'observations': objects, 'source_ca': instance['serverCaCert']['cert']}
    if action in {'bootstrap', 'verify', 'worker-configure', 'worker-verify', 'worker-resume'}:
        import boto3
        from botocore.config import Config
        session = boto3.Session(region_name='eu-west-3')
        settings = Config(connect_timeout=3, read_timeout=10, retries={'max_attempts': 1})
        if session.client('sts', config=settings).get_caller_identity()['Account'] != '804210702561': raise ValueError('Compte AWS inattendu')
        ecs = session.client('ecs', config=settings)
        variables = document['profile']['automation']
        packages = request['packages']
        config = packages['bootstrap-config.json'] if action in {'bootstrap', 'verify'} else packages['worker-config.json']
        family = request['task_definition']
        actual = ecs.describe_task_definition(taskDefinition=family)['taskDefinition']
        if not re.fullmatch(r'cnp-failover-(bootstrap|automation)(-v-[a-f0-9]{10})?', actual['family']): raise ValueError('Tâche opérateur non autorisée')
        bootstrap = action in {'bootstrap', 'verify'}
        config_path = '/tmp/phase1-operation.json'
        payload = json.dumps(config, separators=(',', ':'))
        import base64, zlib
        compressed = base64.b64encode(zlib.compress(payload.encode())).decode()
        if len(compressed) > 6000: raise ValueError('Configuration ECS trop volumineuse')
        def task(operation):
            if bootstrap:
                script = "import os,pathlib,subprocess,base64,zlib; p=pathlib.Path('/tmp/phase1-operation.json'); p.write_bytes(zlib.decompress(base64.b64decode(os.environ['CNP_OPERATION_CONFIG']))); p.chmod(0o600); raise SystemExit(subprocess.call(['python','bootstrap.py','" + operation + "','--config',str(p),'--execute']))"
                override = {'name': 'bootstrap', 'command': [script], 'environment': [{'name': 'CNP_OPERATION_CONFIG', 'value': compressed}]}
            else:
                override = {'name': 'worker', 'command': [operation, '--app', app, '--execute']}
            response = ecs.run_task(cluster=variables['ecs_cluster_arn'], taskDefinition=actual['taskDefinitionArn'], launchType='FARGATE', count=1,
                networkConfiguration={'awsvpcConfiguration': {'subnets': variables['public_subnet_ids'], 'securityGroups': [variables['ecs_security_group_id']], 'assignPublicIp': 'ENABLED'}},
                overrides={'containerOverrides': [override]}, startedBy='cnp-portal-phase1')
            if response.get('failures') or len(response.get('tasks', [])) != 1: raise ValueError('Lancement ECS refusé')
            arn = response['tasks'][0]['taskArn']
            ecs.get_waiter('tasks_stopped').wait(cluster=variables['ecs_cluster_arn'], tasks=[arn], WaiterConfig={'Delay': 5, 'MaxAttempts': 100})
            stopped = ecs.describe_tasks(cluster=variables['ecs_cluster_arn'], tasks=[arn])['tasks'][0]
            if any(container.get('exitCode') != 0 for container in stopped['containers']): raise ValueError('Tâche opérateur en échec ; aucune reprise destructive automatique')
            logs = session.client('logs', config=settings)
            container = actual['containerDefinitions'][0]
            options = container['logConfiguration']['options']
            stream = options['awslogs-stream-prefix'] + '/' + container['name'] + '/' + arn.rsplit('/', 1)[1]
            events = logs.get_log_events(logGroupName=options['awslogs-group'], logStreamName=stream, startFromHead=True)['events']
            messages = []
            for event in events:
                try: messages.append(json.loads(event['message']))
                except ValueError: pass
            return {'arn': arn, 'results': messages}

        ledger = work / 'completed.json'
        completed = json.loads(ledger.read_text()) if ledger.exists() else {}
        operations = ['prepare-source', 'create-target-runtime', 'prepare-target', 'verify-native-tls', 'subscribe'] if action == 'bootstrap' else ['verify-replication'] if action == 'verify' else ['configure'] if action == 'worker-configure' else ['resume'] if action == 'worker-resume' else ['status']
        for operation in operations:
            if action == 'bootstrap' and operation in completed: continue
            completed[operation] = task(operation)
            ledger.write_text(json.dumps(completed))
        if action == 'verify':
            proofs = completed['verify-replication']['results']
            if not any(value.get('fresh_write_replayed') is True and value.get('enabled') and value.get('tables_ready') and value.get('slot_active') and value.get('last_message_age_seconds') is not None and value['last_message_age_seconds'] <= 30 for value in proofs):
                raise ValueError('Réplication fraîche et complète non prouvée')
        if action == 'worker-verify':
            controls = completed['status']['results']
            if not any(value.get('state') in {'DISABLED', 'WAIT_SIGNALS'} and isinstance(value.get('paused'), bool) for value in controls):
                raise ValueError('Worker en pause non prouvé')
        return {'completed': True, 'tasks': completed, 'activated': action == 'worker-resume', 'verified': action in {'verify', 'worker-verify'}}
    raise ValueError('Opération inconnue')


if __name__ == '__main__':
    os.umask(0o077)
    try: print(json.dumps(execute(json.load(sys.stdin))))
    except Exception:
        print(json.dumps({'error': 'Opération interrompue ; vérifier les prérequis et la dernière étape confirmée. Aucun secret affiché.'}))
        raise SystemExit(1)
