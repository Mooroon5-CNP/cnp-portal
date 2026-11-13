#!/usr/bin/env python3
"""Rendu local ECS/RDS prod ; aucun appel cloud, apply, commit ou push."""
from __future__ import annotations
import postgres_contract

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import ssl

ACCOUNT = "626278345026"
REGION = "eu-west-3"
ALLOWED_KEYS = {
    "app_name", "environment", "image", "database_security_group_id", "runtime_secret_arn",
    "runtime_user", "database_name", "listener_priority", "log_group_name", "database_ca_pem", "application_profile", "backup_retention_period", "sql_contract", "container_port", "liveness_path", "readiness_path",
    "master_password_secret",
}
PLATFORM = {
    "vpc": "vpc-0a99bd6da5b289db4",
    "subnets": ["subnet-069399247ab10b23e", "subnet-0259a6e88f0558ab0"],
    "ecs_security_group": "sg-0c8e2003de9c975ef",
    "https_listener": f"arn:aws:elasticloadbalancing:{REGION}:{ACCOUNT}:listener/app/cnp-alb/722456f0108435d7/fd877dabbaff37b7",
}


def validate(config, runtime=False):
    if set(config) - ALLOWED_KEYS:
        raise ValueError("Champs inconnus : ne pas placer de mot de passe ou d'ancien endpoint dans ce profil.")
    if config.get("application_profile") != "postgres":
        raise ValueError("Profil applicatif inconnu.")
    if config.get('application_profile') == 'postgres':
        contract = postgres_contract.validate(config.get('sql_contract'))
        if contract['database'] != config.get('database_name'):
            raise ValueError('Base différente du contrat PostgreSQL.')
    secret = config.get("master_password_secret")
    if "master_password_secret" in config and (not isinstance(secret, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", secret)):
        raise ValueError("Nom de Secret Kubernetes invalide pour le mot de passe administrateur.")
    port = config.get('container_port', 8080)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('Port applicatif invalide.')
    for key in ('liveness_path', 'readiness_path'):
        if key in config and (not isinstance(config[key], str) or not re.fullmatch(r'/[a-zA-Z0-9/_-]*', config[key])):
            raise ValueError('Chemin de santé invalide.')
    retention = config.get("backup_retention_period", 7)
    if type(retention) is not int or not 1 <= retention <= 35:
        raise ValueError("La rétention doit conserver les sauvegardes actives, entre 1 et 35 jours.")
    if config.get("environment") != "prod":
        raise ValueError("Cet exemple AWS est réservé à prod ; le dev reste sur GCP.")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", config.get("app_name", "")):
        raise ValueError("app_name doit contenir de 2 à 40 lettres/chiffres/tirets.")
    if not re.fullmatch(r"sg-[0-9a-f]{8,17}", config.get("database_security_group_id") or ""):
        raise ValueError("Fournir le security group RDS privé réellement autorisé pour ECS.")
    database = config.get("database_name", "appdb")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", database):
        raise ValueError("database_name invalide.")
    if runtime:
        image = config.get("image") or ""
        if not re.fullmatch(rf"{ACCOUNT}\.dkr\.ecr\.{REGION}\.amazonaws\.com/[a-z0-9][a-z0-9/_-]*@sha256:[0-9a-f]{{64}}", image):
            raise ValueError("Une image ECR du compte/région attendus, identifiée par digest, est requise.")
        secret = config.get("runtime_secret_arn") or ""
        if not re.fullmatch(rf"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:[A-Za-z0-9/_+=.@!-]+", secret):
            raise ValueError("Fournir l'ARN réel du secret runtime de ce compte, sans suffixe de clé JSON.")
        if ":secret:rds!db-" in secret:
            raise ValueError("Un secret maître géré par RDS ne doit pas être injecté dans l'application.")
        user = config.get("runtime_user") or ""
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", user) or user in {"postgres", "rdsadmin", "cnp_owner", "root"}:
            raise ValueError("Fournir un utilisateur applicatif limité, distinct de l'administrateur.")
        priority = config.get("listener_priority")
        if type(priority) is not int or not 1 <= priority <= 50000:
            raise ValueError("listener_priority doit être un entier de 1 à 50000, libre sur le listener HTTPS.")
        log_group = config.get("log_group_name")
        if log_group is not None and not re.fullmatch(r"/ecs/[a-zA-Z0-9/_-]+", log_group):
            raise ValueError("Le groupe de logs optionnel doit exister et commencer par /ecs/.")
        if config.get("application_profile") == "postgres":
            if user != "cnp_runtime" or not secret.startswith(f"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:cnp/failover/{config['app_name']}/runtime-"):
                raise ValueError("Un profil PostgreSQL requiert le rôle clôturable cnp_runtime et son secret runtime dédié.")
            if not config.get("database_ca_pem"):
                raise ValueError("CA RDS vérifiée obligatoire pour un profil PostgreSQL.")
        ca = config.get("database_ca_pem")
        if ca is not None:
            try:
                if not isinstance(ca, str) or len(ca) > 65536:
                    raise ValueError()
                ssl.create_default_context(cadata=ca)
            except (ValueError, ssl.SSLError):
                raise ValueError("La CA publique SQL doit contenir un certificat PEM valide.") from None


def resource(api, kind, name, provider, app, wave=0):
    return {"apiVersion": api, "kind": kind,
            "metadata": {"name": name, "labels": {"app": app, "cnp.io/environment": "prod"},
                         "annotations": {"argocd.argoproj.io/sync-wave": str(wave)}},
            "spec": {"forProvider": provider, "providerConfigRef": {"name": "default"}}}


def bootstrap(config):
    validate(config)
    app = config["app_name"]
    name = app + "-prod"
    subnet = resource("rds.aws.upbound.io/v1beta1", "SubnetGroup", name + "-subnets",
                      {"region": REGION, "description": "RDS prive prod - " + app,
                       "subnetIds": PLATFORM["subnets"]}, app)
    params = resource("rds.aws.upbound.io/v1beta1", "ParameterGroup", name + "-pg15",
                      {"region": REGION, "family": "postgres15",
                       "description": "Replication logique aller et retour - " + app,
                       "parameter": [{"name": "rds.logical_replication", "value": "1", "applyMethod": "pending-reboot"}]}, app)
    database = resource("rds.aws.upbound.io/v1beta2", "Instance", name + "-db",
                        {"region": REGION, "identifier": name + "-db", "engine": "postgres", "engineVersion": "15",
                         "instanceClass": "db.t3.micro", "allocatedStorage": 20, "storageEncrypted": True,
                         "username": "cnp_owner", "manageMasterUserPassword": True,
                         "dbName": config.get("database_name", "appdb"), "publiclyAccessible": False,
                         "deletionProtection": True, "skipFinalSnapshot": False,
                         "finalSnapshotIdentifier": name + "-final",
                         "backupRetentionPeriod": config.get("backup_retention_period", 7),
                         "dbSubnetGroupNameRef": {"name": name + "-subnets"},
                         "parameterGroupNameRef": {"name": name + "-pg15"},
                         "vpcSecurityGroupIds": [config["database_security_group_id"]]}, app, 1)
    # Le mot de passe administrateur est le nôtre (Secret Kubernetes de l'app, copié dans AWS Secrets Manager), jamais le secret
    # géré par RDS, dont le nom est aléatoire et que le worker ne pourrait lire qu'avec un droit sur tous les secrets RDS du compte.
    # (Le secret géré servait au pilote, retiré le 07/11/2026.)
    if not config.get("master_password_secret"):
        raise ValueError("Secret Kubernetes du mot de passe administrateur RDS requis.")
    database["spec"]["forProvider"].update(manageMasterUserPassword=False, passwordSecretRef={
        "name": config["master_password_secret"], "namespace": "crossplane-system", "key": "target-admin-password"})
    database["spec"]["deletionPolicy"] = "Orphan"
    return {"rds-subnet-group.yaml": subnet, "rds-parameter-group.yaml": params, "rds-instance.yaml": database}


def observed_endpoint(config, observed):
    name = config["app_name"] + "-prod-db"
    if observed.get("kind") != "Instance" or observed.get("metadata", {}).get("name") != name:
        raise ValueError("Observation RDS d'une autre application ou d'un autre environnement.")
    conditions = {c.get("type"): c.get("status") for c in observed.get("status", {}).get("conditions", [])}
    if conditions.get("Ready") != "True" or conditions.get("Synced") != "True":
        raise ValueError("RDS doit être Ready=True et Synced=True avant de générer la tâche ECS.")
    spec = observed.get("spec", {}).get("forProvider", {})
    actual = observed.get("status", {}).get("atProvider", {})
    if actual.get("arn") != f"arn:aws:rds:{REGION}:{ACCOUNT}:db:{name}":
        raise ValueError("ARN RDS inattendu : vérifier le compte, la région et l'identifiant.")
    if spec.get("publiclyAccessible") is not False or actual.get("publiclyAccessible") is not False:
        raise ValueError("RDS doit être explicitement privée dans le spec et dans l'état observé.")
    if actual.get("dbName") != config.get("database_name", "appdb"):
        raise ValueError("Le nom de base observé ne correspond pas au profil.")
    address = actual.get("address") or ""
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]+\.eu-west-3\.rds\.amazonaws\.com", address):
        raise ValueError("L'adresse réelle de RDS est absente ou n'est pas dans la région attendue.")
    master = actual.get("masterUserSecret", [])
    if isinstance(master, dict):
        master = [master]
    if any(s.get("secretArn") == config["runtime_secret_arn"] for s in master):
        raise ValueError("Le secret maître RDS ne doit pas être injecté dans l'application.")
    return address


def runtime(config, observed):
    validate(config, runtime=True)
    address = observed_endpoint(config, observed)
    app = config["app_name"]
    name = app + "-prod"
    container = {"name": "app", "image": config["image"], "essential": True,
                 "portMappings": [{"containerPort": config.get("container_port", 8080), "protocol": "tcp"}],
                 "environment": [{"name": "DB_HOST", "value": address}, {"name": "DB_PORT", "value": "5432"},
                                 {"name": "DB_NAME", "value": config.get("database_name", "appdb")},
                                 {"name": "DB_USER", "value": config["runtime_user"]},
                                 {"name": "DB_SSLMODE", "value": "verify-full"},
                                 {"name": "DD_ENV", "value": "prod"}],
                 "secrets": [{"name": "DB_PASSWORD", "valueFrom": config["runtime_secret_arn"] + ":password::"}]}
    if config.get("application_profile") == "postgres":
        container["environment"].append({"name": "DB_ENGINE", "value": "postgres"})
    if config.get("database_ca_pem"):
        container["environment"].append({"name": "DB_SSLROOTCERT_PEM", "value": config["database_ca_pem"]})
    if config.get("log_group_name"):
        container["logConfiguration"] = {"logDriver": "awslogs", "options": {
            "awslogs-group": config["log_group_name"], "awslogs-region": REGION, "awslogs-stream-prefix": name}}
    return {**bootstrap(config), **runtime_resources(config, container)}


def runtime_resources(config, container):
    app = config['app_name']
    name = app + '-prod'
    # Inclure tous les paramètres évite de réutiliser une définition immuable
    # après changement de base/secret avec une image identique.
    body = json.dumps([container], sort_keys=True, separators=(",", ":"))
    task_name = name + "-" + hashlib.sha256(body.encode()).hexdigest()[:10]
    task = resource("ecs.aws.upbound.io/v1beta1", "TaskDefinition", task_name,
                    {"region": REGION, "family": name, "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"],
                     "cpu": "256", "memory": "512", "executionRoleArn": f"arn:aws:iam::{ACCOUNT}:role/ecs-execution-role",
                     "taskRoleArn": f"arn:aws:iam::{ACCOUNT}:role/ecs-task-role", "containerDefinitions": body}, app, 2)
    target = resource("elbv2.aws.upbound.io/v1beta1", "LBTargetGroup", name + "-tg",
                      {"region": REGION, "name": (name[:20] + "-" + hashlib.sha256(name.encode()).hexdigest()[:8]),
                       "port": config.get("container_port", 8080), "protocol": "HTTP", "targetType": "ip", "vpcId": PLATFORM["vpc"],
                       # Le standby PostgreSQL garde NOLOGIN : /health=503 est
                       # attendu. ECS doit tester le processus, sinon il tue
                       # continuellement la tâche avant toute promotion SQL.
                       # Mise à jour plus rapide (07/11/2026) : nouvelle tâche saine en ~20 s (2 succès à 10 s, au lieu de
                       # 5 à 30 s), ancienne retirée en 30 s (au lieu de 300 s). Réglages modifiables sur place.
                       "deregistrationDelay": "30",
                       "healthCheck": [{"path": config.get("liveness_path", "/healthz" if config.get("application_profile") == "postgres" else "/health"), "matcher": "200",
                                        "interval": 10, "healthyThreshold": 2, "timeout": 5}]}, app)
    selector = {"matchLabels": {"app": app, "cnp.io/environment": "prod"}}
    rule = resource("elbv2.aws.upbound.io/v1beta1", "LBListenerRule", name + "-https",
                    {"region": REGION, "listenerArn": PLATFORM["https_listener"], "priority": config["listener_priority"],
                     "action": [{"type": "forward", "targetGroupArnSelector": selector}],
                     "condition": [{"hostHeader": [{"values": [app + ".apps.mooroon5.fr"]}]}]}, app, 3)
    service = resource("ecs.aws.upbound.io/v1beta1", "Service", name,
                       {"region": REGION, "cluster": "cnp-cluster", "desiredCount": 1, "launchType": "FARGATE",
                        "taskDefinitionRef": {"name": task_name}, "networkConfiguration": [{"assignPublicIp": False,
                        "subnets": PLATFORM["subnets"], "securityGroups": [PLATFORM["ecs_security_group"]]}],
                        "loadBalancer": [{"containerName": "app", "containerPort": config.get("container_port", 8080), "targetGroupArnSelector": selector}]}, app, 4)
    return {"ecs-task-definition.yaml": task, "ecs-service.yaml": service,
            "alb-target-group.yaml": target, "alb-listener-rule.yaml": rule}


def write_files(files, output):
    if output.exists() and any(output.iterdir()):
        raise ValueError("Choisir un dossier de rendu vide ; aucun fichier existant n'est écrasé.")
    output.mkdir(parents=True, exist_ok=True)
    files = {**files, "kustomization.yaml": {"apiVersion": "kustomize.config.k8s.io/v1beta1",
            "kind": "Kustomization", "resources": sorted(files)}}
    for name, data in files.items():
        # JSON est un sous-ensemble valide de YAML, accepté par Kustomize/Kubernetes.
        (output / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["bootstrap", "runtime"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--rds-json", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        if args.stage == "runtime":
            if args.rds_json is None:
                raise ValueError("runtime requiert --rds-json, export en lecture seule de l'Instance Crossplane.")
            files = runtime(config, json.loads(args.rds_json.read_text()))
        else:
            files = bootstrap(config)
        write_files(files, args.output)
    except (OSError, ValueError, KeyError, TypeError) as error:
        # Les erreurs de validation n'incluent jamais le profil ni les observations.
        print(str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
              else "Entrée illisible ou incomplète ; aucun détail potentiellement sensible affiché.", file=sys.stderr)
        return 1
    print(f"{len(files)} ressources prod rendues localement ; aucun apply, commit ou push.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
