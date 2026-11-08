"""Profil PostgreSQL d'une application, sans SQL libre ni valeur secrète.

Une seule forme : {'database': <nom>}. Les tables, séquences, contraintes et index sont lus dans la base de l'application
elle-même ; rien n'est décrit à la main. Les profils historiques du pilote (recipe, pixelcalm) et la forme déclarative
{database, tables} ont été retirés le 07/11/2026.

Copie unique depuis le 08/11/2026 (auparavant dupliquée entre cnp/deployment/failover-phase1 et config-repo/scripts).
"""
import json
import re


def validate(value):
    if not isinstance(value, dict) or set(value) != {'database'} or not isinstance(value['database'], str) \
            or not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', value['database']):
        raise ValueError('Contrat PostgreSQL invalide : seul le nom de la base se déclare, le schéma se lit dans la base.')
    return value


def encode(value):
    return 'postgres:' + json.dumps(validate(value), sort_keys=True, separators=(',', ':'))


def decode(profile):
    if not isinstance(profile, str) or not profile.startswith('postgres:') or len(profile) > 65536:
        raise ValueError('Profil PostgreSQL inconnu.')
    return validate(json.loads(profile[len('postgres:'):]))


def is_introspected(profile):
    """Vrai pour tout profil PostgreSQL valide : le schéma se lit toujours dans la base."""
    try:
        decode(profile)
        return True
    except (ValueError, TypeError):
        return False


def database_name(profile):
    return decode(profile)['database']
