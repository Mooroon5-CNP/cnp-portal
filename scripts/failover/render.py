#!/usr/bin/env python3
"""Adaptateur pur des générateurs phase 1 : aucune opération cloud ni secret."""
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'config-repo' / 'scripts'))
from prepare_failover_phase1 import build, resolve_credentials


def render(request):
    stage = request['stage']
    if stage not in {'databases', 'runtime', 'dns'}:
        raise ValueError('Étape inconnue')
    profile = resolve_credentials(request['profile'], request['credentials'], request['secrets'])
    baseline = request['baseline']
    result = build(profile, stage, baseline['kustomization'], request.get('observations', {}), baseline.get('urlmap'))
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
        if value.get('spec', {}).get('forProvider') is not None:
            value['spec']['deletionPolicy'] = 'Orphan'
        files[name] = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    return files


if __name__ == '__main__':
    try:
        print(json.dumps(render(json.load(sys.stdin))))
    except Exception as exc:
        print('Rendu phase 1 refusé : ' + type(exc).__name__, file=sys.stderr)
        raise SystemExit(1)
