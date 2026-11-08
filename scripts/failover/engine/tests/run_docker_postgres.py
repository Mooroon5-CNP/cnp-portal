#!/usr/bin/env python3
"""Deux PostgreSQL 15 locaux jetables ; ne lit aucun credential cloud.

Usage : python tests/run_docker_postgres.py --scenario introspected|total-outage
Le réseau, les conteneurs et les volumes créés ici sont nettoyés dans finally.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

IMAGE = 'postgres:15-bookworm@sha256:daeac543477e189e334f159133f4be6dae739b005cec2dfb9d482509fed05465'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario',choices=['total-outage','introspected'],default='introspected')
    args = parser.parse_args()
    token = 'cnp-phase1-' + uuid4().hex[:12]
    containers = []
    network = None
    try:
        network = docker('network', 'create', '--label', 'cnp.local-test=true', token)
        env = {**os.environ}
        if args.scenario == 'total-outage':
            env['CNP_LOCAL_OUTAGE_TEST'] = '1'
        if args.scenario == 'introspected':
            # Le vrai pg_dump 15 s'exécute depuis l'image du serveur, sur le réseau Docker du test.
            env.update(CNP_LOCAL_INTROSPECTED_TEST='1', CNP_LOCAL_DOCKER_NETWORK=token, CNP_LOCAL_IMAGE=IMAGE)
        for alias, variable in [('source', 'CNP_LOCAL_SOURCE_DSN'), ('target', 'CNP_LOCAL_TARGET_DSN')]:
            name = token + '-' + alias
            cid = docker('run', '--rm', '--detach', '--name', name,
                '--label', 'cnp.local-test=true', '--network', token, '--network-alias', alias,
                '--publish', '127.0.0.1::5432', '--env', 'POSTGRES_USER=cnp_local_admin',
                '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE, 'postgres',
                '-c', 'wal_level=logical', '-c', 'max_replication_slots=8',
                '-c', 'max_wal_senders=8', '-c', 'max_logical_replication_workers=8')
            containers.append(cid)
            deadline = time.monotonic() + 60
            while subprocess.run(['docker','exec',cid,'pg_isready','-U','cnp_local_admin'],
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
                if time.monotonic() >= deadline:
                    raise RuntimeError('PostgreSQL local ne démarre pas.')
                time.sleep(0.3)
            # pg_isready peut voir le serveur temporaire d'init : attendre TCP.
            port = json.loads(docker('inspect',cid))[0]['NetworkSettings']['Ports']['5432/tcp'][0]['HostPort']
            env[variable] = f'host=127.0.0.1 port={port} user=cnp_local_admin dbname=cnp_local_admin sslmode=disable'
        env['CNP_LOCAL_REPLICATION_DSN'] = 'host=source port=5432 user=cnp_replication dbname=cnp_local_admin sslmode=disable'
        # Attendre le serveur TCP final, pas seulement l'instance temporaire d'init.
        import psycopg
        for variable in ['CNP_LOCAL_SOURCE_DSN','CNP_LOCAL_TARGET_DSN']:
            deadline=time.monotonic()+30
            while True:
                try:
                    with psycopg.connect(env[variable],connect_timeout=2): pass
                    break
                except psycopg.Error:
                    if time.monotonic()>deadline: raise RuntimeError('Serveur local final indisponible') from None
                    time.sleep(0.2)
        # Le test vérifie lui-même les adresses loopback avant tout SQL.
        test_file = {'total-outage': 'test_outage_postgres.py', 'introspected': 'test_introspected_postgres.py'}[args.scenario]
        return subprocess.run([sys.executable,str(Path(__file__).with_name(test_file))],env=env).returncode
    finally:
        for cid in reversed(containers):
            # --volumes nettoie seulement les volumes anonymes de NOS conteneurs.
            subprocess.run(['docker','rm','--force','--volumes',cid],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        if network:
            subprocess.run(['docker','network','rm',network],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    raise SystemExit(main())
