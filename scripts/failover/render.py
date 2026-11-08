#!/usr/bin/env python3
"""Adaptateur pur des générateurs phase 1 : aucune opération cloud ni secret."""
import json
import os
from pathlib import Path
import sys

# Générateurs : dans engine/, à côté de ce script (déplacés du config-repo le 08/11/2026, une seule copie).
sys.path.insert(0, str(Path(__file__).resolve().parent / 'engine'))
from prepare_failover_phase1 import build, resolve_credentials, automation_profile, runtime_profiles, credentials_profile, validate
import render_stateless_phase1 as stateless
import render_failover_phase1 as gcp
import render_aws_prod_example as aws
from prepare_failover_phase1 import merge_kustomization

WORKER_KINDS = {'MetricAlarm', 'TableItem'}


def render(request):
    stage = request['stage']
    if stage not in {'protection', 'databases', 'runtime', 'dns', 'worker', 'bootstrap', 'automation', 'secrets', 'validate'}:
        raise ValueError('Étape inconnue')
    no_database = request['profile'].get('mode') == 'stateless'
    if stage == 'validate':
        if no_database: stateless.validate(request['profile'])
        else:
            validate(request['profile'])
            if request['secrets'].get('initialized'):
                resolve_credentials(request['profile'], request['credentials'], request['secrets'])
        return {}
    if stage == 'worker' and no_database:
        raise ValueError('Aucune configuration de worker pour une application sans état')
    if no_database:
        stateless.validate(request['profile'])
        profile = request['profile']
    else:
        profile = resolve_credentials(request['profile'], request['credentials'], request['secrets'])
    if stage in {'bootstrap', 'automation', 'secrets', 'validate'}:
        if no_database:
            raise ValueError('Aucune initialisation SQL pour une application sans état')
        if stage == 'secrets':
            return {'initialize-secrets-config.json': credentials_profile(profile, request['credentials'])}
        if stage == 'bootstrap':
            return {'bootstrap-config.json': runtime_profiles(profile, request.get('observations', {}), request['credentials'], request['secrets'])}
        return automation_profile(profile, request.get('observations', {}), request['credentials'], request['secrets'])
    baseline = request['baseline']
    if no_database:
        if stage == 'databases':
            raise ValueError('Aucune base pour une application sans état')
        result = {} if stage == 'protection' else stateless.runtime(profile) if stage == 'runtime' else gcp.dns(profile['gcp'])
        if stage == 'runtime':
            result['application-network.yaml'] = {'apiVersion': 'v1', 'kind': 'List', 'items': list(gcp.network(profile['gcp']).values())}
        if stage != 'protection':
            result['kustomization.yaml'] = merge_kustomization(baseline['kustomization'], result)
        result = {f"apps/{profile['gcp']['app_name']}/crossplane/prod/{name}": value for name, value in result.items()}
        if stage == 'runtime':
            result['platform/application-routing/urlmap.yaml'] = gcp.routing(profile['gcp'], baseline['urlmap'])
    else:
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
            values = {entry['name']: entry for entry in old_containers[0].get(key, [])}
            values.update({entry['name']: entry for entry in new_containers[0].get(key, [])})
            if values:
                container[key] = list(values.values())
        # Calculer le nom immuable après conservation des paramètres applicatifs.
        runtime = aws.runtime_resources(profile['aws'], container)
        result.update({f"apps/{profile['gcp']['app_name']}/crossplane/prod/{name}": value for name, value in runtime.items()})
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
            env = {v['name']: v for v in old_container.get('env', [])}
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
