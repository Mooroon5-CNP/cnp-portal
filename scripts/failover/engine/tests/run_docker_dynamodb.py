#!/usr/bin/env python3
"""Un DynamoDB local jetable (image officielle AWS) pour tester la configuration et les gardes du worker.

Aucun credential cloud n'est lu : le client utilise des identifiants factices et l'adresse du conteneur.
Le conteneur et lui seul est supprimé à la fin.
"""
import os
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

IMAGE = 'amazon/dynamodb-local:latest'


def docker(*args):
    return subprocess.check_output(['docker', *args], text=True, stderr=subprocess.PIPE).strip()


def main():
    name = 'cnp-dynamodb-' + uuid4().hex[:10]
    container = None
    try:
        container = docker('run', '--rm', '--detach', '--name', name, '--label', 'cnp.local-test=true',
            '--publish', '127.0.0.1::8000', IMAGE, '-jar', 'DynamoDBLocal.jar', '-inMemory', '-sharedDb')
        port = docker('port', name, '8000/tcp').splitlines()[0].rsplit(':', 1)[1]
        url = f'http://127.0.0.1:{port}'
        import boto3
        client = boto3.client('dynamodb', endpoint_url=url, region_name='eu-west-3',
            aws_access_key_id='local', aws_secret_access_key='local')
        deadline = time.monotonic() + 60
        while True:
            try:
                client.list_tables()
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise RuntimeError('DynamoDB local ne démarre pas.') from None
                time.sleep(0.3)
        env = {**os.environ, 'CNP_LOCAL_DYNAMODB_URL': url}
        return subprocess.run([sys.executable, str(Path(__file__).with_name('test_platform_worker_dynamodb.py'))], env=env).returncode
    finally:
        if container:
            subprocess.run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    raise SystemExit(main())
