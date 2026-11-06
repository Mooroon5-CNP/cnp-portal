#!/usr/bin/env python3
"""Exécution opérateur bornée de phase 1 ; entrée/sortie JSON sans secret."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
from uuid import uuid4

def engine_root(environ=os.environ, here=Path(__file__).resolve()):
    """Racine du moteur phase 1 (bootstrap.py, automation.py, platform_secrets.py…).

    CNP_FAILOVER_ENGINE_ROOT l'impose (portail déployé, disposition inhabituelle) et n'a alors aucun repli : une
    valeur fausse doit échouer, pas être remplacée en silence par un autre moteur. Sans elle, on reconnaît les deux
    dispositions du dépôt : dépôts côte à côte (projet/cnp et projet/cnp-portal) ou portail imbriqué dans cnp
    (cnp/cnp-portal).
    """
    configured = environ.get('CNP_FAILOVER_ENGINE_ROOT')
    candidates = [Path(configured)] if configured else [
        here.parents[3] / 'cnp' / 'deployment' / 'failover-phase1',
        here.parents[3] / 'deployment' / 'failover-phase1',
    ]
    for candidate in candidates:
        if (candidate / 'bootstrap.py').is_file():
            return candidate.resolve()
    raise FileNotFoundError('Moteur phase 1 introuvable : définir CNP_FAILOVER_ENGINE_ROOT.')


try:
    ROOT = engine_root()
except FileNotFoundError as error:
    # Le portail attend du JSON sur stdout : sans lui, il n'afficherait qu'« opérateur indisponible ».
    if __name__ == '__main__':
        print(json.dumps({'error': str(error)}))
        raise SystemExit(1)
    raise
sys.path.insert(0, str(ROOT))
import postgres_contract


class UserAction(ValueError):
    """Cause connue, sans secret, que le manager peut corriger : son message est affiché tel quel (une panne inconnue ne l'est jamais)."""


# Lectures sans effet : jamais de reprise d'une ancienne tâche (son résultat serait périmé), un nouveau jeton à chaque fois.
READ_ONLY_OPERATIONS = {'inspect-source'}
# Actions exécutées par la tâche d'initialisation SQL (image bootstrap) ; les autres passent par celle du worker.
BOOTSTRAP_ACTIONS = {'bootstrap', 'bootstrap-roles', 'schema-check', 'verify'}


def bootstrap_operations(action, introspected):
    """Opérations SQL d'une action d'initialisation.

    Profil introspecté : rôles d'abord (avant l'application), puis, une fois son schéma créé, lecture et restauration de ce
    schéma avant l'abonnement. Profil historique : tout en une fois, comme avant.
    """
    if action == 'bootstrap':
        return (['prepare-source', 'restore-schema', 'prepare-target', 'verify-native-tls', 'subscribe'] if introspected
                else ['prepare-source', 'create-target-runtime', 'prepare-target', 'verify-native-tls', 'subscribe'])
    return {'bootstrap-roles': ['create-target-runtime'], 'schema-check': ['inspect-source'], 'verify': ['verify-replication']}[action]


# Aucune CLI : le portail est fait pour tourner dans le cluster. Chaque lecture passe par une API, avec l'identité de
# l'environnement (pod du portail, sinon poste de l'opérateur et `kube_context` du profil).
PROJECT = 'cnp-terraform-512313'
# Ressources Crossplane observées (cluster-scoped). La version est celle que le cluster préfère, comme le faisait `kubectl get`.
OBSERVED = [('cloudsql', 'sql.gcp.upbound.io', 'databaseinstances', '{app}-prod-gcp-db'),
            ('rds', 'rds.aws.upbound.io', 'instances', '{app}-prod-db'),
            ('healthcheck', 'route53.aws.upbound.io', 'healthchecks', '{app}-failover'),
            ('routing_latch', 'route53.aws.upbound.io', 'healthchecks', '{app}-failover-latch-http'),
            ('primary_healthcheck', 'route53.aws.upbound.io', 'healthchecks', '{app}-failover-primary-health')]
# Noms des déclencheurs et de la table d'état, par régime (le pilote garde les siens).
NAMES = {'pilot': {'state_table': 'cnp-failover-automation', 'rules': ['cnp-failover-automation-alarm', 'cnp-failover-automation-retry']},
         'platform': {'state_table': 'cnp-failover-platform-state', 'rules': ['cnp-failover-platform-alarm', 'cnp-failover-platform-retry']}}
TASK_FAMILY = r'cnp-failover-(bootstrap|automation)(-v-[a-f0-9]{10})?|cnp-failover-platform-(bootstrap|worker)'


def google_get(url, session=None):
    """Lecture d'une API Google avec les identifiants par défaut de l'environnement (Workload Identity dans le cluster)."""
    if session is None:
        import google.auth
        from google.auth.transport.requests import AuthorizedSession
        credentials, _ = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
        session = AuthorizedSession(credentials)
    response = session.get(url, timeout=30)
    if response.status_code != 200:
        raise ValueError('Lecture GCP refusée ; vérifier les droits de l’identité du portail.')
    return response.json()


def kubernetes_clients(context=None):
    from kubernetes import client, config
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config(context=context)
    return client.ApisApi(), client.CustomObjectsApi()


def ready(value):
    conditions = {c.get('type'): c.get('status') for c in (value or {}).get('status', {}).get('conditions', [])}
    return conditions.get('Ready') == 'True' and conditions.get('Synced') == 'True'


def observe_objects(app, apis, custom):
    """Ressources Crossplane de l'app. Une base absente arrête ; une sonde absente (404) est normale avant les DNS.
    Toute autre erreur (droits, API) arrête aussi : « pas trouvé » n'est pas « n'existe pas »."""
    from kubernetes.client.exceptions import ApiException
    preferred = {group.name: group.preferred_version.version for group in apis.get_api_versions().groups}
    objects = {}
    for key, group, plural, name in OBSERVED:
        try:
            objects[key] = custom.get_cluster_custom_object(group, preferred[group], plural, name.format(app=app))
        except ApiException as error:
            if error.status != 404 or key in {'cloudsql', 'rds'}:
                raise ValueError('Bases absentes ou inaccessibles' if key in {'cloudsql', 'rds'} else 'Lecture des sondes refusée') from None
    return objects


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
    if action == 'runtime-verify':
        import boto3
        cloudrun = google_get(f'https://run.googleapis.com/v2/projects/{PROJECT}/locations/europe-west9/services/{app}-prod', request.get('_google'))
        # Prête, sans reconfiguration en cours, et la dernière révision créée est celle qui sert.
        # L'API omet `reconciling` quand il est faux (JSON des API Google : valeurs par défaut non écrites).
        primary_ready = cloudrun.get('terminalCondition', {}).get('state') == 'CONDITION_SUCCEEDED' and not cloudrun.get('reconciling', False)
        primary_ready &= bool(cloudrun.get('latestReadyRevision')) and cloudrun.get('latestReadyRevision') == cloudrun.get('latestCreatedRevision')
        client = boto3.client('ecs', region_name='eu-west-3')
        if boto3.client('sts', region_name='eu-west-3').get_caller_identity()['Account'] != '804210702561':
            raise ValueError('Compte AWS inattendu')
        services = client.describe_services(cluster='cnp-cluster', services=[app + '-prod'])['services']
        standby_ready = len(services) == 1 and services[0]['runningCount'] > 0 and services[0]['pendingCount'] == 0
        standby_ready &= bool(services) and any(value.get('status') == 'PRIMARY' and value.get('rolloutState') == 'COMPLETED'
            and value.get('taskDefinition') == services[0]['taskDefinition'] for value in services[0].get('deployments', []))
        groups = services[0].get('loadBalancers', []) if services else []
        target_ready = bool(groups)
        for group in groups:
            targets = boto3.client('elbv2', region_name='eu-west-3').describe_target_health(TargetGroupArn=group['targetGroupArn'])['TargetHealthDescriptions']
            target_ready &= bool(targets) and all(value['TargetHealth']['State'] == 'healthy' for value in targets)
        images = request.get('images')
        images_ready = not images
        if images and services:
            containers = client.describe_task_definition(taskDefinition=services[0]['taskDefinition'])['taskDefinition']['containerDefinitions']
            primary_image = cloudrun.get('template', {}).get('containers', [{}])[0].get('image')
            images_ready = primary_image == images['gcp'] and any(value.get('image') == images['aws'] for value in containers)
        return {'verified': primary_ready and standby_ready and target_ready and images_ready,
            'primary_ready': primary_ready, 'standby_ready': standby_ready, 'target_ready': target_ready,
            'images_ready': images_ready, 'observed_at': int(time.time())}
    if action == 'health':
        import boto3, urllib.request, ssl, botocore
        from botocore.config import Config
        client = lambda name, region='eu-west-3': boto3.client(name, region_name=region, config=Config(connect_timeout=3, read_timeout=5, retries={'max_attempts': 0}))
        if client('sts').get_caller_identity()['Account'] != '804210702561': raise ValueError('Compte AWS inattendu')
        try:
            with urllib.request.urlopen('https://' + app + '.apps.mooroon5.fr' + document['profile']['gcp'].get('readiness_path', '/health'), timeout=10, context=ssl.create_default_context(cafile=str(Path(botocore.__file__).parent / 'cacert.pem'))) as response:
                public_ready = response.status == 200
        except Exception: public_ready = False
        services = client('ecs').describe_services(cluster=document['profile'].get('automation', {}).get('ecs_cluster_arn', 'cnp-cluster'), services=[app + '-prod'])['services']
        aws_ready = len(services) == 1 and services[0]['runningCount'] >= 1 and services[0]['pendingCount'] == 0
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from render_failover_phase1 import ZONE
        records = client('route53').list_resource_record_sets(HostedZoneId=ZONE, StartRecordName=app + '.apps.mooroon5.fr', StartRecordType='A', MaxItems='10')['ResourceRecordSets']
        own = [record for record in records if record['Name'].rstrip('.') == app + '.apps.mooroon5.fr' and record['Type'] == 'A']
        primary = next((record for record in own if record.get('Failover') == 'PRIMARY'), {})
        secondary = next((record for record in own if record.get('Failover') == 'SECONDARY'), {})
        alias = secondary.get('AliasTarget', {}).get('DNSName', '').rstrip('.').removeprefix('dualstack.')
        dns_ready = len(own) == 2 and [record['Value'] for record in primary.get('ResourceRecords', [])] == [document['profile']['gcp']['gcp_lb_ip']] and bool(primary.get('HealthCheckId')) and alias == 'cnp-alb-1733646164.eu-west-3.elb.amazonaws.com'
        if document['profile'].get('mode') == 'stateless':
            return {'verified': public_ready and aws_ready and dns_ready, 'public_ready': public_ready, 'aws_ready': aws_ready, 'dns_ready': dns_ready, 'observed_at': int(time.time()), 'state': 'STATELESS'}
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from prepare_failover_phase1 import regime
        names = NAMES[regime(document['profile'])]
        def decode(item):
            return {key: value.get('S') if 'S' in value else value.get('BOOL') if 'BOOL' in value else int(value['N']) for key, value in item.items()}
        records = {}
        for name in ['CONTROL', 'REPLICATION']:
            records[name] = decode(client('dynamodb').get_item(TableName=names['state_table'], Key={'app': {'S': app}, 'record': {'S': name}}, ConsistentRead=True).get('Item', {}))
        control, replication = records['CONTROL'], records['REPLICATION']
        fresh = 0 <= int(time.time()) - replication.get('observed_at', 0) <= 120 and 0 <= int(time.time()) - replication.get('last_message_at', 0) <= 120
        import automation
        expected = next(value for value in request['packages']['worker-config.json']['applications'] if value['app'] == app)
        configured = control.get('config_hash') == automation.config_hash(expected) and control.get('config_hash') == replication.get('config_hash')
        triggers_ready = bool(request.get('task_definition'))
        for rule in names['rules']:
            events = client('events')
            try:
                enabled = events.describe_rule(Name=rule)['State'] == 'ENABLED'
                targets = events.list_targets_by_rule(Rule=rule)['Targets']
                triggers_ready &= enabled and any(value.get('EcsParameters', {}).get('TaskDefinitionArn') == request.get('task_definition') for value in targets)
            except Exception: triggers_ready = False
        healthy = control.get('paused') is False and (control.get('state') == 'AWS_ACTIVE' or (control.get('state') == 'WAIT_SIGNALS' and fresh and configured))
        return {'verified': healthy and configured and triggers_ready and public_ready and aws_ready and dns_ready, 'public_ready': public_ready, 'aws_ready': aws_ready,
            'configured': configured, 'triggers_ready': triggers_ready,
            'dns_ready': dns_ready, 'state': control.get('state', 'UNCONFIGURED'), 'paused': control.get('paused'), 'replication_fresh': fresh,
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
    if action == 'initialize-secrets':
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from prepare_failover_phase1 import credentials_profile, platform_secrets_profile, regime
        if regime(document['profile']) == 'platform':
            # Conteneurs et valeurs naissent ensemble par l'API, depuis le Secret Kubernetes d'origine : ni Terraform ni CLI.
            import platform_secrets
            return platform_secrets.execute(platform_secrets_profile(document['profile']), document['profile']['automation'].get('kube_context'))
        import initialize_secrets
        import boto3
        client = boto3.client('sts', region_name='eu-west-3')
        if client.get_caller_identity()['Account'] != '804210702561': raise ValueError('Compte AWS inattendu')
        config = credentials_profile(document['profile'], document['credentials'])
        return {'secrets': initialize_secrets.initialize(config, boto3.client('secretsmanager', region_name='eu-west-3'))}
    if action == 'observe':
        # Le validateur partagé vérifie les références de secrets (et le contexte GKE quand il est fourni).
        sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
        from prepare_failover_phase1 import credentials_profile
        credentials_profile(document['profile'], document['credentials'])
        apis, custom = request.get('_kubernetes') or kubernetes_clients(document['profile']['automation'].get('kube_context'))
        objects = observe_objects(app, apis, custom)
        instance = google_get(f'https://sqladmin.googleapis.com/v1/projects/{PROJECT}/instances/{app}-prod-gcp-db', request.get('_google'))
        # Lire n'est pas prouver : les étapes suivantes exigent des bases prêtes (et, après les DNS, des sondes prêtes).
        # Une observation non prête fait attendre le parcours au lieu de le laisser passer.
        wanted = ['cloudsql', 'rds'] + (['healthcheck', 'routing_latch', 'primary_healthcheck'] if request.get('expect_probes') else [])
        missing = [key for key in wanted if not ready(objects.get(key))]
        return {'observations': objects, 'source_ca': instance['serverCaCert']['cert'], 'verified': not missing,
                'message': None if not missing else 'En attente : ' + ', '.join(missing) + ' pas encore prêt(s).'}
    if action in BOOTSTRAP_ACTIONS | {'worker-configure', 'worker-verify', 'worker-resume'}:
        import boto3
        from botocore.config import Config
        session = boto3.Session(region_name='eu-west-3')
        settings = Config(connect_timeout=3, read_timeout=10, retries={'max_attempts': 1})
        if session.client('sts', config=settings).get_caller_identity()['Account'] != '804210702561': raise ValueError('Compte AWS inattendu')
        ecs = session.client('ecs', config=settings)
        variables = document['profile']['automation']
        packages = request['packages']
        config = packages['bootstrap-config.json'] if action in BOOTSTRAP_ACTIONS else packages['worker-config.json']
        family = request['task_definition']
        actual = ecs.describe_task_definition(taskDefinition=family)['taskDefinition']
        if not re.fullmatch(TASK_FAMILY, actual['family']): raise ValueError('Tâche opérateur non autorisée')
        bootstrap = action in BOOTSTRAP_ACTIONS
        introspected = bootstrap and postgres_contract.is_introspected(config['profile'])
        if action in {'bootstrap-roles', 'schema-check'} and not introspected:
            raise ValueError('Étape réservée aux profils introspectés')
        config_path = '/tmp/phase1-operation.json'
        payload = json.dumps(config, separators=(',', ':'))
        import base64, zlib
        compressed = base64.b64encode(zlib.compress(payload.encode())).decode()
        if len(compressed) > 6000: raise ValueError('Configuration ECS trop volumineuse')
        pending_file = work / 'task-requests.json'
        pending = json.loads(pending_file.read_text()) if pending_file.exists() else {}
        def task(operation):
            if bootstrap:
                script = "import os,pathlib,subprocess,base64,zlib; p=pathlib.Path('/tmp/phase1-operation.json'); p.write_bytes(zlib.decompress(base64.b64decode(os.environ['CNP_OPERATION_CONFIG']))); p.chmod(0o600); raise SystemExit(subprocess.call(['python','bootstrap.py','" + operation + "','--config',str(p),'--execute']))"
                override = {'name': 'bootstrap', 'command': [script], 'environment': [{'name': 'CNP_OPERATION_CONFIG', 'value': compressed}]}
            else:
                override = {'name': 'worker', 'command': [operation, '--app', app, '--execute']}
            arn = pending.get(operation) if operation not in READ_ONLY_OPERATIONS else None
            if arn:
                # Reprise : une tâche en cours ou réussie est réutilisée (jamais deux fois la même opération SQL). Une tâche
                # terminée en échec ne l'est pas : relire son échec bloquerait toute reprise, d'où une nouvelle tentative numérotée.
                # Une tâche qu'ECS ne connaît plus (oubliée environ une heure après son arrêt) n'a pas réussi : une réussite serait
                # inscrite au journal des opérations terminées, qui la ferait sauter.
                previous = ecs.describe_tasks(cluster=variables['ecs_cluster_arn'], tasks=[arn])['tasks']
                if not previous or previous[0].get('lastStatus') == 'STOPPED' and any(c.get('exitCode') != 0 for c in previous[0].get('containers', [])):
                    pending[operation + '#attempt'] = pending.get(operation + '#attempt', 0) + 1
                    arn = None
            if not arn:
                nonce = uuid4().hex if operation in READ_ONLY_OPERATIONS else str(pending.get(operation + '#attempt') or '')
                response = ecs.run_task(clientToken=hashlib.sha256((str(work) + operation + nonce).encode()).hexdigest(), cluster=variables['ecs_cluster_arn'], taskDefinition=actual['taskDefinitionArn'], launchType='FARGATE', count=1,
                    networkConfiguration={'awsvpcConfiguration': {'subnets': variables['public_subnet_ids'], 'securityGroups': [variables['ecs_security_group_id']], 'assignPublicIp': 'ENABLED'}},
                    overrides={'containerOverrides': [override]}, startedBy='cnp-portal-phase1')
                if response.get('failures') or len(response.get('tasks', [])) != 1: raise ValueError('Lancement ECS refusé')
                arn = response['tasks'][0]['taskArn']
                pending[operation] = arn
                pending_file.write_text(json.dumps(pending))
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
        operations = bootstrap_operations(action, introspected) if bootstrap else ['configure'] if action == 'worker-configure' else ['resume'] if action == 'worker-resume' else ['status']
        for operation in operations:
            # Une initialisation interrompue reprend où elle s'est arrêtée : un rôle déjà créé ne se recrée pas.
            if action in {'bootstrap', 'bootstrap-roles'} and operation in completed: continue
            completed[operation] = task(operation)
            ledger.write_text(json.dumps(completed))
        if action == 'verify':
            proofs = completed['verify-replication']['results']
            # Un schéma introspecté doit être identique des deux côtés ; l'absence de la mesure n'est pas une preuve.
            schema_ok = lambda value: value.get('schema_in_sync') is True if introspected else value.get('schema_in_sync') is not False
            if not any(value.get('fresh_write_replayed') is True and value.get('enabled') and value.get('tables_ready') and value.get('slot_active') and value.get('last_message_age_seconds') is not None and value['last_message_age_seconds'] <= 30 and schema_ok(value) for value in proofs):
                raise ValueError('Réplication fraîche et complète non prouvée')
        if action == 'worker-verify':
            controls = completed['status']['results']
            import automation
            expected = next(value for value in config['applications'] if value['app'] == app)
            if not any(value.get('state') == 'DISABLED' and value.get('paused') is True and value.get('config_hash') == automation.config_hash(expected) for value in controls):
                raise ValueError('Worker en pause non prouvé')
        if action == 'schema-check':
            seen = next((value for value in reversed(completed['inspect-source']['results']) if 'schema_ready' in value), None)
            if seen is None: raise ValueError('Lecture du schéma de la source non confirmée')
            if seen.get('unsupported'):
                raise UserAction('Schéma de l\'application non pris en charge : ' + '; '.join(str(item) for item in seen['unsupported'][:8]) + '.')
            return {'completed': True, 'tasks': completed, 'activated': False, 'verified': seen['schema_ready'] is True,
                    'schema_ready': seen['schema_ready'] is True, 'tables': seen.get('tables', 0),
                    'message': None if seen['schema_ready'] else 'Aucune table dans la base de l\'application : l\'appeler une fois (créer une donnée) pour qu\'elle crée son schéma.'}
        return {'completed': True, 'tasks': completed, 'activated': action == 'worker-resume', 'verified': action in {'verify', 'worker-verify'}}
    raise ValueError('Opération inconnue')


def main():
    os.umask(0o077)
    try: print(json.dumps(execute(json.load(sys.stdin))))
    except UserAction as error:
        print(json.dumps({'error': str(error), 'action_required': True}))
        raise SystemExit(1)
    except Exception:
        print(json.dumps({'error': 'Opération interrompue ; vérifier les prérequis et la dernière étape confirmée. Aucun secret affiché.'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
