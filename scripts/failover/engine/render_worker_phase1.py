#!/usr/bin/env python3
"""Ressources Crossplane propres à une app pour le worker de bascule (régime plateforme).

Deux objets, publiés par GitOps avec le reste des manifests de l'app, à la place de la pile Terraform par app :
- l'alarme CloudWatch qui surveille la sonde Route 53 de l'app (région us-east-1) ;
- l'enregistrement de configuration de l'app dans la table lue par le worker.

Aucune valeur secrète : la configuration ne contient que des références (ARN, hôtes, certificats publics).
"""
import json

import render_aws_prod_example as aws

CONFIG_TABLE = "cnp-failover-platform-config"
ALARM_PREFIX = "cnp-failover-platform-"
HEALTH_REGION = "us-east-1"


def check(application):
    if not isinstance(application, dict) or not isinstance(application.get("app"), str) or \
            application.get("alarm_name") != ALARM_PREFIX + application["app"]:
        raise ValueError("Configuration d'application du régime plateforme requise.")


def alarm(application):
    """Une minute sans réponse saine de la sonde (deux minutes à l'origine, réduit le 06/11/2026 : les 3 échecs de la sonde
    filtrent déjà les coupures brèves, et le worker exige encore 30 s d'alarme)."""
    check(application)
    app = application["app"]
    value = aws.resource("cloudwatch.aws.upbound.io/v1beta1", "MetricAlarm", application["alarm_name"], {
        "region": HEALTH_REGION, "namespace": "AWS/Route53", "metricName": "HealthCheckStatus",
        "dimensions": {"HealthCheckId": application["health_check_id"]}, "statistic": "Maximum", "period": 60,
        "evaluationPeriods": 1, "datapointsToAlarm": 1, "comparisonOperator": "LessThanThreshold", "threshold": 1,
        "treatMissingData": "missing"}, app, 3)
    # Le nom d'une alarme est son identifiant externe : le fournisseur n'a pas de champ « nom ».
    value["metadata"]["annotations"]["crossplane.io/external-name"] = application["alarm_name"]
    value["metadata"]["labels"]["cnp-failover"] = "alarm"
    return value


def config_item(application):
    """Un enregistrement par app : `app` (clé) et `config` (JSON). Le worker le lit, le valide et en calcule l'empreinte."""
    check(application)
    app = application["app"]
    config = json.dumps(application, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    item = json.dumps({"app": {"S": app}, "config": {"S": config}}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    value = aws.resource("dynamodb.aws.upbound.io/v1beta1", "TableItem", app + "-failover-config", {
        "region": aws.REGION, "tableName": CONFIG_TABLE, "hashKey": "app", "item": item}, app, 3)
    value["metadata"]["labels"]["cnp-failover"] = "config"
    return value


def manifests(application):
    return {"failover-alarm.yaml": alarm(application), "failover-config.yaml": config_item(application)}
