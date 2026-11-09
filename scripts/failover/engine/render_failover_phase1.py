#!/usr/bin/env python3
"""Préparer Cloud SQL ou le DNS de recette hors GitOps, sans aucun déploiement."""
from __future__ import annotations
import postgres_contract
import argparse
from copy import deepcopy
import ipaddress
import json
from pathlib import Path
import re
import ssl
import sys

from render_aws_prod_example import resource, write_files

PROJECT = "cnp-terraform-512313"
ZONE = "Z03070463OHUIPXFTWDYQ"


def validate(config):
    allowed = {"app_name", "environment", "database_name", "credentials_secret_name", "gcp_lb_ip", "gcp_runtime", "application_profile", "sql_contract", "container_port", "liveness_path", "readiness_path", "database_instance", "billing_mode"}
    if set(config) - allowed:
        raise ValueError("Champs inconnus : aucun mot de passe/image/endpoint SQL dans ce profil.")
    # Seul le profil PostgreSQL existe : le profil sans base a été retiré le 08/11/2026.
    if config.get("application_profile") != "postgres":
        raise ValueError("Profil applicatif inconnu (PostgreSQL requis).")
    if config.get('application_profile') == 'postgres':
        contract = postgres_contract.validate(config.get('sql_contract'))
        if contract['database'] != config.get('database_name'):
            raise ValueError('Base différente du contrat PostgreSQL.')
    port = config.get('container_port', 8080)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError('Port applicatif invalide.')
    for key in ('liveness_path', 'readiness_path'):
        if key in config and (not isinstance(config[key], str) or not re.fullmatch(r'/[a-zA-Z0-9/_-]*', config[key])):
            raise ValueError('Chemin de santé invalide.')
    app = config.get("app_name", "")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", app) or config.get("environment") != "prod":
        raise ValueError("Une application nommée explicitement, en prod seulement, est requise.")
    if not re.fullmatch(r"[a-z][a-z0-9_]{0,62}", config.get("database_name", "appdb")):
        raise ValueError("database_name invalide.")
    if "database_instance" in config and not re.fullmatch(rf"{re.escape(app)}-prod-gcp-db-[a-z0-9]{{1,12}}", str(config["database_instance"])):
        raise ValueError("Nom d'instance Cloud SQL inattendu.")
    return app


def instance_name(config):
    """Nom de l'instance chez Google. Un nom d'instance supprimée reste bloqué environ une semaine : le portail ajoute donc une
    génération (`<app>-prod-gcp-db-<génération>`) pour qu'une app supprimée puisse être redéployée aussitôt sous le même nom.
    Sans génération (apps antérieures au 06/11/2026), le nom historique."""
    return config.get("database_instance") or config["app_name"] + "-prod-gcp-db"


def cloudsql(config):
    app = validate(config)
    secret = config.get("credentials_secret_name") or ""
    if not re.fullmatch(r"[a-z][a-z0-9-]{1,100}", secret):
        raise ValueError("Fournir le nom du secret Kubernetes privé préprovisionné, jamais sa valeur.")
    # Noms distincts des objets RDS cluster-scoped, également appelés *-prod-db.
    name = app + "-prod-gcp-db"
    def ref(key):
        return {"name": secret, "namespace": "crossplane-system", "key": key}
    instance = resource("sql.gcp.upbound.io/v1beta2", "DatabaseInstance", name, {
        "project": PROJECT, "region": "europe-west9", "databaseVersion": "POSTGRES_15",
        "deletionProtection": True, "rootPasswordSecretRef": ref("admin-password"),
        "settings": {"edition": "ENTERPRISE", "tier": "db-f1-micro", "availabilityType": "ZONAL",
            "diskSize": 10, "diskAutoresize": True, "deletionProtectionEnabled": True,
            "backupConfiguration": {"enabled": True, "pointInTimeRecoveryEnabled": True,
                "transactionLogRetentionDays": 7},
            "databaseFlags": [{"name": "cloudsql.logical_decoding", "value": "on"}],
            "ipConfiguration": {"ipv4Enabled": False,
                "privateNetwork": f"projects/{PROJECT}/global/networks/gcp-hybrid-vpc",
                "sslMode": "ENCRYPTED_ONLY"}}}, app)
    instance["spec"]["deletionPolicy"] = "Orphan"
    if instance_name(config) != name:
        # Le nom Kubernetes reste stable (observations, parcours) ; seul le nom chez Google porte la génération.
        instance["metadata"]["annotations"]["crossplane.io/external-name"] = instance_name(config)
    database = resource("sql.gcp.upbound.io/v1beta1", "Database", name + "-app", {
        "project": PROJECT, "instanceRef": {"name": name}}, app, 1)
    database["metadata"]["annotations"]["crossplane.io/external-name"] = config.get("database_name", "appdb")
    database["spec"]["deletionPolicy"] = "Orphan"
    files = {"cloudsql-instance.yaml": instance, "cloudsql-database.yaml": database}
    for user, key in [("cnp_runtime", "runtime-password"), ("cnp_replication", "replication-password")]:
        obj = resource("sql.gcp.upbound.io/v1beta2", "User", app + "-prod-gcp-" + user.replace("_", "-"), {
            "project": PROJECT, "type": "BUILT_IN", "instanceRef": {"name": name},
            "passwordSecretRef": ref(key)}, app, 1)
        obj["metadata"]["annotations"]["crossplane.io/external-name"] = user
        obj["spec"]["deletionPolicy"] = "Orphan"
        files[user + ".yaml"] = obj
    return files


def observed_endpoint(config, observed):
    app = validate(config)
    conditions = {c.get("type"): c.get("status") for c in observed.get("status", {}).get("conditions", [])}
    actual = observed.get("status", {}).get("atProvider", {})
    name = app + "-prod-gcp-db"
    if observed.get("kind") != "DatabaseInstance" or observed.get("metadata", {}).get("name") != name or conditions.get("Ready") != "True" or conditions.get("Synced") != "True":
        raise ValueError("Observation Cloud SQL Ready/Synced de cette application requise.")
    if actual.get("connectionName") != f"{PROJECT}:europe-west9:{instance_name(config)}":
        raise ValueError("Instance Cloud SQL d'un autre projet/région/application.")
    address = ipaddress.IPv4Address(actual.get("privateIpAddress") or "")
    if address not in ipaddress.ip_network("10.189.0.0/16"):
        raise ValueError("Adresse privée Cloud SQL hors de la plage du tunnel.")
    return str(address)


def cloudrun(config, observed):
    app = validate(config)
    p = config.get("gcp_runtime") or {}
    if set(p) != {"image", "service_account", "subnetwork", "password_secret", "password_version", "database_ca_pem"}:
        raise ValueError("Les six entrées gcp_runtime doivent être renseignées explicitement.")
    if not re.fullmatch(rf"europe-west9-docker\.pkg\.dev/{PROJECT}/cnp-registry/[a-z0-9-]+@sha256:[a-f0-9]{{64}}", p.get("image") or ""):
        raise ValueError("Image GAR du projet attendue, identifiée par digest.")
    if not re.fullmatch(rf"[a-z0-9-]+@{PROJECT}\.iam\.gserviceaccount\.com", p.get("service_account") or ""):
        raise ValueError("Compte de service runtime du projet requis.")
    if not re.fullmatch(rf"projects/{PROJECT}/regions/europe-west9/subnetworks/[a-z0-9-]+", p.get("subnetwork") or ""):
        raise ValueError("Sous-réseau Direct VPC réel requis.")
    if not re.fullmatch(rf"projects/{PROJECT}/secrets/[a-zA-Z0-9_-]+", p.get("password_secret") or "") or not re.fullmatch(r"[1-9][0-9]*", p.get("password_version") or ""):
        raise ValueError("Secret Manager et version numérique requis ; jamais de mot de passe en clair.")
    ca = p.get("database_ca_pem")
    if not isinstance(ca,str) or len(ca)>65536:
        raise ValueError("CA publique Cloud SQL requise.")
    try:
        ssl.create_default_context(cadata=ca)
    except (ValueError,ssl.SSLError):
        raise ValueError("CA Cloud SQL invalide.") from None
    address = observed_endpoint(config, observed)
    service = resource("cloudrun.gcp.upbound.io/v1beta2", "V2Service", app+"-prod", {
        "project":PROJECT, "location":"europe-west9", "ingress":"INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
        "template":{"serviceAccount":p["service_account"],
            "vpcAccess":{"egress":"PRIVATE_RANGES_ONLY", "networkInterfaces":[{
                "network":f"projects/{PROJECT}/global/networks/gcp-hybrid-vpc", "subnetwork":p["subnetwork"]}]},
            "containers":[{"image":p["image"], "ports":{"containerPort":config.get("container_port", 8080)},
                "env":[{"name":"DB_HOST","value":str(address)},{"name":"DB_NAME","value":config.get("database_name","appdb")},
                    {"name":"DB_USER","value":"cnp_runtime"},{"name":"DB_SSLMODE","value":"verify-ca"},
                    {"name":"DB_SSLROOTCERT_PEM","value":ca},
                    {"name":"DB_PASSWORD","valueSource":{"secretKeyRef":{"secret":p["password_secret"],"version":p["password_version"]}}}]}]}},app,2)
    if config.get("application_profile") == "postgres":
        service["spec"]["forProvider"]["template"]["containers"][0]["env"].append({"name":"DB_ENGINE","value":"postgres"})
    if config.get("billing_mode", "usage") not in {"usage", "instance"}:
        raise ValueError("Mode de facturation inconnu.")
    if config.get("billing_mode") == "instance":
        # Facturation à l'instance (choisie au déploiement) : une instance toujours active, sans démarrage à froid que la sonde
        # Route 53 pourrait prendre pour une panne.
        service["spec"]["forProvider"]["template"]["scaling"] = {"minInstanceCount": 1}
        service["spec"]["forProvider"]["template"]["containers"][0]["resources"] = {"cpuIdle": False}
    iam = resource("cloudrun.gcp.upbound.io/v1beta2", "ServiceIAMMember", app+"-prod-public", {
        "project":PROJECT,"location":"europe-west9","service":app+"-prod","role":"roles/run.invoker","member":"allUsers"},app,3)
    return {"cloudrun-claim.yaml":service,"cloudrun-iam.yaml":iam}


def network(config):
    """Même nommage que le portail : pas de second NEG/backend pour l'app."""
    app = validate(config)
    service = app + "-prod"
    neg, backend = "cnp-" + service + "-neg", "cnp-" + service + "-backend"
    api = "compute.gcp.upbound.io/v1beta1"
    common = {"project": PROJECT}
    return {
        "application-neg.yaml": resource(api, "RegionNetworkEndpointGroup", neg, {
            **common, "region": "europe-west9", "networkEndpointType": "SERVERLESS", "cloudRun": [{"service": service}]}, app, 4),
        "application-backend.yaml": resource(api, "BackendService", backend, {
            **common, "protocol": "HTTP", "loadBalancingScheme": "EXTERNAL_MANAGED", "timeoutSec": 30,
            "backend": [{"group": f"https://www.googleapis.com/compute/v1/projects/{PROJECT}/regions/europe-west9/networkEndpointGroups/{neg}"}]}, app, 5),
    }


def routing(config, baseline):
    """Copie la map fournie et ne modifie que la route appartenant à cette prod.

    Le résultat est une proposition à relire sur une révision récente. Aucune
    lecture distante ni publication automatique du snapshot partagé.
    """
    app = validate(config)
    metadata = baseline.get("metadata", {})
    spec = baseline.get("spec", {})
    annotations = metadata.get("annotations", {})
    if baseline.get("apiVersion") != "compute.gcp.upbound.io/v1beta1" or baseline.get("kind") != "URLMap" or metadata.get("name") != "cnp-application-routing" or \
            annotations.get("crossplane.io/external-name") != "cnp-apps-urlmap" or spec.get("deletionPolicy") != "Orphan" or \
            sorted(spec.get("managementPolicies", [])) != ["Observe", "Update"] or \
            spec.get("forProvider", {}).get("project") != PROJECT or not spec.get("forProvider", {}).get("defaultService"):
        raise ValueError("Baseline de routage partagée absente ou incompatible.")
    doc = {"apiVersion": baseline["apiVersion"], "kind": "URLMap",
        "metadata": {"name": metadata["name"], "annotations": deepcopy(annotations)}, "spec": deepcopy(spec)}
    if "labels" in metadata:
        doc["metadata"]["labels"] = deepcopy(metadata["labels"])
    fp = doc["spec"]["forProvider"]
    host, matcher = app + ".apps.mooroon5.fr", "cnp-" + app + "-prod"
    owner = "cnp.io/route-" + app + "-prod"
    registered = annotations.get(owner)
    if registered is not None and registered != host:
        raise ValueError("Route existante enregistrée sous un autre nom d'hôte.")
    rules, matchers = fp.get("hostRule", []), fp.get("pathMatcher", [])
    if any(host in rule.get("hosts", []) and (rule.get("pathMatcher") != matcher or registered != host or rule.get("hosts") != [host]) for rule in rules):
        raise ValueError("Nom d'hôte déjà détenu par une autre route.")
    if any(rule.get("pathMatcher") == matcher and rule.get("hosts") != [host] for rule in rules):
        raise ValueError("Matcher partagé avec un autre hôte ; aucune modification automatique.")
    if registered is None and any(m.get("name") == matcher for m in matchers):
        raise ValueError("Matcher existant non détenu par cette application.")
    backend = f"https://www.googleapis.com/compute/v1/projects/{PROJECT}/global/backendServices/{matcher}-backend"
    fp["hostRule"] = [r for r in rules if r.get("pathMatcher") != matcher] + [{"hosts": [host], "pathMatcher": matcher}]
    own_matcher = deepcopy(next((m for m in matchers if m.get("name") == matcher), {"name": matcher}))
    own_matcher["defaultService"] = backend
    fp["pathMatcher"] = [m for m in matchers if m.get("name") != matcher] + [own_matcher]
    doc["metadata"]["annotations"][owner] = host
    return doc


def dns(config):
    app = validate(config)
    address = str(ipaddress.IPv4Address(config.get("gcp_lb_ip", "")))
    if not ipaddress.ip_address(address).is_global:
        raise ValueError("Fournir l'IP publique du load balancer GCP, pas celle de Cloud SQL.")
    labels = {"app": app, "cnp.io/environment": "prod", "cnp-failover": "health"}
    check = resource("route53.aws.upbound.io/v1beta1", "HealthCheck", app + "-failover", {
        "region": "us-east-1", "type": "HTTPS", "ipAddress": address, "port": 443,
        "fqdn": app + ".apps.mooroon5.fr", "enableSni": True, "resourcePath": config.get("readiness_path", "/health"),
        # Sonde rapide (10 s, 3 échecs : ~30 s) depuis le 06/11/2026 ; 30 s faisait perdre une minute à la détection. Réglage
        # figé à la création chez Route 53 : seules les sondes créées ensuite en profitent.
        "requestInterval": 10, "failureThreshold": 3}, app)
    check["metadata"]["labels"] = labels
    latch = resource("route53.aws.upbound.io/v1beta1", "HealthCheck", app + "-failover-latch-http", {
        "region": "us-east-1", "type": "HTTPS", "ipAddress": address, "port": 443,
        "fqdn": app + ".apps.mooroon5.fr", "enableSni": True, "resourcePath": config.get("readiness_path", "/health"),
        "requestInterval": 30, "failureThreshold": 3, "disabled": True}, app)
    # Le worker possède la fermeture persistante ; ArgoCD/Crossplane ne doit
    # jamais rouvrir le verrou lors d'une synchronisation après la promotion.
    # Une sonde désactivée est constamment healthy ; l'inversion ferme le verrou.
    # AWS interdit d'imbriquer deux contrôles CALCULATED : ce verrou est une feuille.
    latch["spec"]["initProvider"] = {"invertHealthcheck": False}
    latch["spec"]["managementPolicies"] = ["Observe", "Create", "Update"]
    primary_labels = {**labels, "cnp-failover": "primary"}
    combined = resource("route53.aws.upbound.io/v1beta1", "HealthCheck", app + "-failover-primary-health", {
        "region": "us-east-1", "type": "CALCULATED", "childHealthThreshold": 2,
        "childHealthchecksRefs": [{"name": app + "-failover", "policy": {"resolve": "Always"}},
            {"name": app + "-failover-latch-http", "policy": {"resolve": "Always"}}]}, app, 1)
    combined["metadata"]["labels"] = primary_labels
    common = {"region": "us-east-1", "zoneId": ZONE, "name": app + ".apps.mooroon5.fr", "type": "A"}
    primary = resource("route53.aws.upbound.io/v1beta2", "Record", app + "-failover-primary", {
        **common, "ttl": 60, "records": [address], "setIdentifier": app + "-gcp-primary",
        "failoverRoutingPolicy": {"type": "PRIMARY"},
        "healthCheckIdSelector": {"matchLabels": primary_labels}}, app, 2)
    secondary = resource("route53.aws.upbound.io/v1beta2", "Record", app + "-failover-secondary", {
        **common, "setIdentifier": app + "-aws-secondary", "failoverRoutingPolicy": {"type": "SECONDARY"},
        "alias": {"name": "cnp-alb-1733646164.eu-west-3.elb.amazonaws.com", "zoneId": "Z3Q77PNBQS71R4",
            "evaluateTargetHealth": False}}, app, 2)
    # Le secondaire reste éligible même avant LOGIN : il répondra 503 jusque-là.
    # La santé globale d'un ALB partagé ne représente pas cette application et
    # deux réponses "unhealthy" pourraient faire choisir de nouveau le primaire.
    return {"healthcheck.yaml": check, "healthcheck-latch-http.yaml": latch,
        "healthcheck-primary.yaml": combined, "record-primary.yaml": primary, "record-secondary.yaml": secondary}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=["cloudsql", "cloudrun", "network", "routing", "dns"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sql-json", type=Path)
    parser.add_argument("--urlmap-json", type=Path, help="Snapshot JSON récent de la map partagée ; sortie à relire avant publication")
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text())
        if args.stage=="cloudrun":
            if args.sql_json is None:
                raise ValueError("Observation Cloud SQL requise.")
            files = cloudrun(config,json.loads(args.sql_json.read_text()))
        elif args.stage == "network":
            files = network(config)
        elif args.stage == "routing":
            if args.urlmap_json is None:
                raise ValueError("Snapshot de la map partagé requis.")
            files = {"urlmap.yaml": routing(config, json.loads(args.urlmap_json.read_text()))}
        else:
            files = cloudsql(config) if args.stage == "cloudsql" else dns(config)
        write_files(files, args.output)
    except (OSError, ValueError, TypeError, KeyError):
        print("Profil incomplet ou invalide ; aucun détail sensible affiché.", file=sys.stderr)
        return 1
    print(f"{len(files)} ressources rendues localement. Aucun appel cloud ni publication GitOps.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
