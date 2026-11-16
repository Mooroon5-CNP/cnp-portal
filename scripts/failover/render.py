#!/usr/bin/env python3
"""Adaptateur pur des générateurs phase 1 : aucune opération cloud ni secret."""
import json
import os
from pathlib import Path
import re
import sys

# Générateurs : dans engine/, à côté de ce script (déplacés du config-repo le 08/11/2026, une seule copie).
sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine'))
from prepare_failover_phase1 import build, resolve_credentials, automation_profile, runtime_profiles, credentials_profile, validate
import render_aws_prod_example as aws

WORKER_KINDS = {'MetricAlarm', 'TableItem'}


def managed_gcp_variable(item, app):
    secret = item.get('valueSource', {}).get('secretKeyRef', {}).get('secret', '')
    return isinstance(secret, str) and bool(re.fullmatch(r'cnp-' + re.escape(app) + r'-prod-var-[a-f0-9]{12}', secret))


def managed_aws_variable(item, app):
    ref = item.get('valueFrom', '')
    return isinstance(ref, str) and bool(re.fullmatch(r'arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:cnp/failover/'
                                                      + re.escape(app) + r'/env-[a-f0-9]{12}-[A-Za-z0-9]{6}:::[0-9a-f-]{36}', ref))


def inject_runtime_variables(result, profile, references):
    """Add references only after the generator has merged existing runtime settings."""
    app = profile['gcp']['app_name']
    prefix = f'apps/{app}/crossplane/prod/'
    gcp_refs = references.get('gcp')
    aws_refs = references.get('aws')
    role = references.get('aws_execution_role')
    if (not isinstance(gcp_refs, list) or not isinstance(aws_refs, list)
            or len(gcp_refs) != len(aws_refs) or not isinstance(role, str)
            or not re.fullmatch(r'arn:aws:iam::\d{12}:role/[A-Za-z0-9_+=,.@/-]+', role)):
        raise ValueError('Références runtime du secours invalides.')
    gcp_path = prefix + 'cloudrun-claim.yaml'
    aws_path = prefix + 'ecs-task-definition.yaml'
    gcp = result[gcp_path]
    aws_task = result[aws_path]
    gcp_container = gcp['spec']['forProvider']['template']['containers'][0]
    aws_containers = json.loads(aws_task['spec']['forProvider']['containerDefinitions'])
    if len(aws_containers) != 1:
        raise ValueError('Topologie ECS inattendue pour les variables.')
    aws_container = aws_containers[0]
    gcp_existing = {item['name'] for item in gcp_container.get('env', [])}
    aws_existing = {item['name'] for item in aws_container.get('secrets', [])}
    gcp_names = {item.get('name') for item in gcp_refs}
    aws_names = {item.get('name') for item in aws_refs}
    if (gcp_names != aws_names or len(gcp_names) != len(gcp_refs)
            or gcp_names & gcp_existing or aws_names & aws_existing):
        raise ValueError('Variables du secours incohérentes ou en conflit avec le runtime.')
    for item in gcp_refs:
        ref = item.get('valueSource', {}).get('secretKeyRef', {})
        if (not isinstance(item.get('name'), str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', item['name'])
                or not isinstance(ref.get('secret'), str) or not ref.get('secret')
                or not isinstance(ref.get('version'), str) or not re.fullmatch(r'[1-9][0-9]*', ref['version'])):
            raise ValueError('Référence Secret Manager GCP invalide.')
    for item in aws_refs:
        if (not isinstance(item.get('name'), str) or not isinstance(item.get('valueFrom'), str)
                or not re.fullmatch(r'arn:aws:secretsmanager:[a-z0-9-]+:\d{12}:secret:cnp/failover/'
                                    + re.escape(app) + r'/env-[a-f0-9]{12}-[A-Za-z0-9]{6}:::[0-9a-f-]{36}',
                                    item['valueFrom'])):
            raise ValueError('Référence Secrets Manager AWS invalide.')
    gcp_container['env'].extend(gcp_refs)
    aws_container.setdefault('secrets', []).extend(aws_refs)
    rendered = aws.runtime_resources(profile['aws'], aws_container)
    result.update({prefix + name: value for name, value in rendered.items()})
    result[aws_path]['spec']['forProvider']['executionRoleArn'] = role


def render(request):
    stage = request['stage']
    if stage not in {'protection', 'databases', 'runtime', 'dns', 'worker', 'bootstrap', 'automation', 'secrets', 'validate'}:
        raise ValueError('Étape inconnue')
    # Plus de profil sans base (retiré le 08/11/2026) : refusé explicitement plutôt que rendu à moitié.
    if request['profile'].get('mode') == 'stateless':
        raise ValueError('Failover sans base retiré le 08/11/2026 : seul le profil PostgreSQL existe (choix « GCP Cloud SQL » en prod).')
    if stage == 'validate':
        validate(request['profile'])
        if request['secrets'].get('initialized'):
            resolve_credentials(request['profile'], request['credentials'], request['secrets'])
        return {}
    profile = resolve_credentials(request['profile'], request['credentials'], request['secrets'])
    if stage in {'bootstrap', 'automation', 'secrets', 'validate'}:
        if stage == 'secrets':
            return {'initialize-secrets-config.json': credentials_profile(profile, request['credentials'])}
        if stage == 'bootstrap':
            return {'bootstrap-config.json': runtime_profiles(profile, request.get('observations', {}), request['credentials'], request['secrets'])}
        return automation_profile(profile, request.get('observations', {}), request['credentials'], request['secrets'])
    baseline = request['baseline']
    result = {} if stage == 'protection' else build(profile, stage, baseline['kustomization'], request.get('observations', {}), baseline.get('urlmap'),
                              request.get('credentials'), request.get('secrets'))
    ecs_path = f"apps/{profile['gcp']['app_name']}/crossplane/prod/ecs-task-definition.yaml"
    if stage == 'runtime' and ecs_path in baseline['files']:
        before = json.loads(baseline['files'][ecs_path])
        old_containers = json.loads(before['spec']['forProvider']['containerDefinitions'])
        new_containers = json.loads(result[ecs_path]['spec']['forProvider']['containerDefinitions'])
        if len(old_containers) != 1 or len(new_containers) != 1 or old_containers[0]['name'] != new_containers[0]['name']:
            raise ValueError('Topologie ECS existante différente ; revue dédiée requise')
        container = {**old_containers[0], **new_containers[0]}
        for key in ('environment', 'secrets'):
            old_values = old_containers[0].get(key, [])
            if key == 'secrets' and request.get('runtime_variables'):
                old_values = [entry for entry in old_values if not managed_aws_variable(entry, profile['gcp']['app_name'])]
            values = {entry['name']: entry for entry in old_values}
            values.update({entry['name']: entry for entry in new_containers[0].get(key, [])})
            if values:
                container[key] = list(values.values())
        # Calculer le nom immuable après conservation des paramètres applicatifs.
        runtime = aws.runtime_resources(profile['aws'], container)
        result.update({f"apps/{profile['gcp']['app_name']}/crossplane/prod/{name}": value for name, value in runtime.items()})
    if stage == 'runtime' and request.get('runtime_variables'):
        inject_runtime_variables(result, profile, request['runtime_variables'])
    # Le lot courant et tous les lots déjà présents restent référencés.
    # Le bucket et les données historiques ne sont jamais retirés.
    files = dict(baseline['files'])
    for name, value in result.items():
        if stage == 'runtime' and name.endswith('/cloudrun-claim.yaml') and name in files:
            old = json.loads(files[name])
            # Conserver labels, annotations, volumes et variables existantes ;
            # remplacer uniquement les champs du profil PostgreSQL approuvé.
            for k in ('labels', 'annotations'):
                value['metadata'][k] = {**old['metadata'].get(k, {}), **value['metadata'].get(k, {})}
            before = old['spec']['forProvider']['template']
            after = value['spec']['forProvider']['template']
            old_container = before.get('containers', [{}])[0]
            new_container = after['containers'][0]
            old_env = old_container.get('env', [])
            if request.get('runtime_variables'):
                old_env = [v for v in old_env if not managed_gcp_variable(v, profile['gcp']['app_name'])]
            env = {v['name']: v for v in old_env}
            env.update({v['name']: v for v in new_container.get('env', [])})
            after['containers'][0] = {**old_container, **new_container, 'env': list(env.values())}
            value['spec']['forProvider']['template'] = {**before, **after}
        # Conserver les ressources cloud en cas de retrait accidentel de CR.
        # Exception : l'alarme et l'enregistrement de configuration du worker suivent la vie de l'application (voir `protect`).
        if value.get('spec', {}).get('forProvider') is not None and value.get('kind') not in WORKER_KINDS:
            value['spec']['deletionPolicy'] = 'Orphan'
        files[name] = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    def protect(value):
        if value.get('kind') == 'List':
            for item in value['items']:
                protect(item)
        elif value.get('kind') in WORKER_KINDS:
            # Retirer l'application doit retirer sa configuration : sinon le worker continuerait à surveiller et à agir pour elle.
            value['spec'].pop('deletionPolicy', None)
        elif value.get('spec', {}).get('forProvider') is not None:
            value['spec']['deletionPolicy'] = 'Orphan'
            if value.get('kind') == 'HealthCheck' and value['metadata']['name'] == profile['gcp']['app_name'] + '-failover-latch':
                # Ancien contrôle calculé conservé, sans mutation ni suppression cloud.
                value['spec']['managementPolicies'] = ['Observe']
            if (value.get('kind') == 'Instance'
                    and value['metadata']['name'] == profile['gcp']['app_name'] + '-prod-db'
                    and 'backup_retention_period' in profile['aws']):
                retention = profile['aws']['backup_retention_period']
                if type(retention) is not int or not 1 <= retention <= 35:
                    raise ValueError('Rétention de sauvegarde invalide')
                value['spec']['forProvider']['backupRetentionPeriod'] = retention
            if value.get('kind') == 'Bucket':
                # Réadoption du bucket historique : ni création ni suppression.
                value['spec']['managementPolicies'] = ['Observe']
                value['metadata'].setdefault('annotations', {})['crossplane.io/external-name'] = value['metadata']['name']
                value['spec']['forProvider']['forceDestroy'] = False
    for name, text in files.items():
        value = json.loads(text)
        protect(value)
        files[name] = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    return files


if __name__ == '__main__':
    try:
        print(json.dumps(render(json.load(sys.stdin))))
    except ValueError as exc:
        # Les refus des générateurs sont des phrases fixes, sans secret : les afficher dit au manager quoi attendre ou corriger.
        print('Rendu refusé : ' + str(exc), file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print('Rendu phase 1 refusé : ' + type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)
