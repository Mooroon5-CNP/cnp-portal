#!/usr/bin/env python3
"""Delete only portal-owned Secrets Manager entries after the ECS runtime is gone."""
import hashlib
import json
import re
import sys


def execute(request, client):
    app, names, region = request.get('app'), request.get('names'), request.get('region')
    if (not isinstance(app, str) or not re.fullmatch(r'[a-z][a-z0-9-]{0,38}[a-z0-9]', app)
            or not isinstance(names, list) or len(names) > 10000
            or not isinstance(region, str) or not re.fullmatch(r'[a-z]{2}-[a-z]+-[0-9]', region)):
        raise ValueError('Profil AWS des variables invalide.')
    for key in names:
        if not isinstance(key, str) or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
            raise ValueError('Variable AWS invalide.')
        digest = hashlib.sha256(key.encode()).hexdigest()[:12]
        name = f'cnp/failover/{app}/env-{digest}'
        try:
            existing = client.describe_secret(SecretId=name)
        except Exception as error:
            if getattr(error, 'response', {}).get('Error', {}).get('Code') == 'ResourceNotFoundException':
                continue
            raise
        actual = {item['Key']: item['Value'] for item in existing.get('Tags', [])}
        if (actual.get('Application') != app or actual.get('Environment') != 'prod'
                or actual.get('ManagedBy') != 'cnp-portal-variables'):
            raise ValueError('Secret AWS existant hors du périmètre du portail.')
        # Suppression immédiate, comme les secrets de la plateforme (platform_secrets.remove) : avec une fenêtre de
        # récupération, le nom restait réservé 7 jours et un redéploiement de la même app échouait à recréer le secret
        # (constaté le 21/11/2026 sur recette-aws-2111). Un secret déjà planifié est purgé de même. Les versions OpenBao,
        # source des valeurs, sont détruites ensuite par le portail.
        client.delete_secret(SecretId=existing['ARN'], ForceDeleteWithoutRecovery=True)


def main():
    try:
        import boto3
        request = json.load(sys.stdin)
        execute(request, boto3.client('secretsmanager', region_name=request.get('region')))
    except Exception:
        print('Suppression AWS des variables indisponible ou refusée.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
