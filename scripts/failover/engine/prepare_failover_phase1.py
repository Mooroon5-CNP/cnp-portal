#!/usr/bin/env python3
"""Paquet de modifications à relire : aucune publication Git ni opération cloud."""
from copy import deepcopy
import argparse
import hashlib
import json
from pathlib import Path
import re
import ssl
import subprocess
import sys

import postgres_contract
import render_failover_phase1 as gcp
import render_aws_prod_example as aws
import render_worker_phase1 as worker

STAGES = ["secrets", "databases", "runtime", "dns", "worker", "bootstrap", "automation"]
# Secrets d'une app (régime plateforme, le seul depuis le retrait du pilote le 07/11/2026).
ROLES = {"bootstrap", "source-admin", "runtime", "target-admin"}
PLATFORM_TASKS = {"bootstrap_task_definition": "cnp-failover-platform-bootstrap", "worker_task_definition": "cnp-failover-platform-worker"}


def document(path):
    text = path.read_text()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        try:
            import yaml
        except ImportError:
            raise ValueError("Installer requirements.phase1.txt pour lire une baseline YAML.") from None
        return yaml.safe_load(text)


def regime(profile):
    """Toujours « platform » pour un profil valide : alarme et configuration publiées par GitOps, secret administrateur RDS à nous.
    Le régime « pilot » (première version du failover) a été retiré le 07/11/2026 ; un profil sans régime est refusé par validate."""
    if profile.get("automation", {}).get("regime") != "platform":
        raise ValueError("Profil hors du régime plateforme : le régime historique du pilote n'existe plus.")
    return "platform"


def validate(profile):
    if not isinstance(profile, dict) or set(profile) != {"gcp", "aws", "automation"}:
        raise ValueError("Trois sections gcp/aws/automation attendues, sans valeur secrète.")
    app = gcp.validate(profile["gcp"])
    aws.validate(profile["aws"])
    for key, default in [("app_name", None), ("environment", None), ("application_profile", None), ("database_name", "appdb"), ("sql_contract", None), ("container_port", 8080), ("readiness_path", "/health")]:
        if profile["gcp"].get(key, default) != profile["aws"].get(key, default):
            raise ValueError("Les deux clouds doivent porter la même application, base, prod et profil SQL.")
    if profile["gcp"].get("application_profile") != "postgres":
        raise ValueError("Profil PostgreSQL requis.")
    required = {"worker_image", "ecs_cluster_arn", "ecs_security_group_id", "public_subnet_ids", "subscription_ca_path_on_rds", "kube_context"}
    optional = {"subscription_tls_mode", "acknowledge_wireguard_subscriber_trust", "regime", *PLATFORM_TASKS}
    if not required <= set(profile["automation"]) or set(profile["automation"]) - required - optional:
        raise ValueError("Configuration d'orchestration invalide.")
    regime(profile)
    # Un seul Secret Kubernetes porte les mots de passe de l'app ; il sert aussi de mot de passe administrateur à RDS.
    secret = profile["aws"].get("master_password_secret")
    if secret is None or secret != profile["gcp"].get("credentials_secret_name"):
        raise ValueError("Mot de passe administrateur RDS : le Secret Kubernetes de l'app est requis.")
    # La plateforme crée elle-même le Secret Kubernetes de l'app : son nom découle de l'app, jamais d'un choix libre.
    if profile["gcp"].get("credentials_secret_name") != f"cnp-{app}-sql":
        raise ValueError("Secret Kubernetes de l'app attendu : cnp-<app>-sql.")
    # Tâches ECS de la pile Terraform plateforme, créées une fois avec ces noms.
    if {key: profile["automation"].get(key) for key in PLATFORM_TASKS} != PLATFORM_TASKS:
        raise ValueError("Tâches ECS de la pile plateforme requises.")
    return app


def merge_kustomization(baseline, names):
    if not isinstance(baseline, dict) or baseline.get("kind") != "Kustomization" or not isinstance(baseline.get("resources"), list):
        raise ValueError("Kustomization de production existante requise.")
    resources = baseline["resources"]
    if any(not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9_.-]+\.ya?ml", name) for name in resources):
        raise ValueError("Ressource hors du dossier applicatif ; revue manuelle requise.")
    result = deepcopy(baseline)
    result["resources"] = list(dict.fromkeys([*resources, *sorted(names)]))
    return result


def build(profile, stage, baseline, observations=None, urlmap=None, credentials=None, secret_result=None):
    app = validate(profile)
    observations = observations or {}
    if stage == "databases":
        files = {**gcp.cloudsql(profile["gcp"]), **aws.bootstrap(profile["aws"])}
    elif stage == "runtime":
        files = {**gcp.cloudrun(profile["gcp"], observations["cloudsql"]),
            **aws.runtime(profile["aws"], observations["rds"])}
        # Même fichier et mêmes objets que le portail, sans doubler la propriété.
        files["application-network.yaml"] = {"apiVersion": "v1", "kind": "List", "items": list(gcp.network(profile["gcp"]).values())}
    elif stage == "dns":
        files = gcp.dns(profile["gcp"])
    elif stage == "worker":
        if credentials is None or secret_result is None:
            raise ValueError("Sorties des conteneurs et résultat d'initialisation requis.")
        files = worker.manifests(automation_profile(profile, observations, credentials, secret_result)["worker-config.json"]["applications"][0])
    else:
        raise ValueError("Étape de manifestes inconnue.")
    files["kustomization.yaml"] = merge_kustomization(baseline, files)
    candidate = {f"apps/{app}/crossplane/prod/{name}": value for name, value in files.items()}
    if stage == "runtime":
        if urlmap is None:
            raise ValueError("La map partagée est requise pour raccorder Cloud Run.")
        candidate["platform/application-routing/urlmap.yaml"] = gcp.routing(profile["gcp"], urlmap)
    return candidate


def output_value(outputs, key):
    value = outputs[key]
    return value.get("value") if isinstance(value, dict) and "value" in value else value


def credentials_profile(profile, outputs):
    app = validate(profile)
    refs = output_value(outputs, "aws_secret_arns")
    secret = output_value(outputs, "gcp_runtime_secret")
    if not isinstance(refs, dict) or set(refs) != ROLES or secret != f"projects/{gcp.PROJECT}/secrets/{app}-prod-runtime":
        raise ValueError("Sorties de conteneurs gérés requises.")
    for role, arn in refs.items():
        if not isinstance(arn, str) or not re.fullmatch(
                rf"arn:aws:secretsmanager:{aws.REGION}:{aws.ACCOUNT}:secret:cnp/failover/{app}/{role}-[A-Za-z0-9]{{6}}", arn):
            raise ValueError("ARN de conteneur incohérent.")
    context = profile["automation"].get("kube_context")
    # Le portail déployé lit le cluster avec l'identité de son pod : le contexte est facultatif (poste de l'opérateur seulement).
    if context is not None and (not isinstance(context, str) or not re.fullmatch(
            rf"gke_{gcp.PROJECT}_europe-west9(?:-[abc])?_(?:main-production-cluster|cnp-cluster-terraform)", context)):
        raise ValueError("Contexte GKE explicitement observé requis.")
    return {"app": app, "kube_context": context, "kubernetes_secret": profile["gcp"]["credentials_secret_name"],
        "aws_secret_arns": refs, "gcp_runtime_secret": secret}


def platform_secrets_profile(profile):
    """Régime plateforme : ce qu'il faut pour créer les secrets par l'API (aucun conteneur Terraform préalable)."""
    app = validate(profile)
    return {"app": app, "kubernetes_secret": profile["gcp"]["credentials_secret_name"],
        "gcp_runtime_service_account": profile["gcp"]["gcp_runtime"]["service_account"]}


def resolve_credentials(profile, outputs, result):
    """Complète uniquement les références absentes, sans écraser un choix différent."""
    config = credentials_profile(profile, outputs)
    if result.get("app") != config["app"] or result.get("initialized") is not True or \
            not isinstance(result.get("gcp_password_version"), str) or not re.fullmatch(r"[1-9][0-9]*", result["gcp_password_version"]):
        raise ValueError("Résultat d'initialisation expurgé de cette recette requis.")
    resolved = deepcopy(profile)
    pairs = [(resolved["aws"], "runtime_secret_arn", config["aws_secret_arns"]["runtime"]),
        (resolved["gcp"]["gcp_runtime"], "password_secret", config["gcp_runtime_secret"]),
        (resolved["gcp"]["gcp_runtime"], "password_version", result["gcp_password_version"])]
    for target, key, value in pairs:
        if target.get(key) is not None and target[key] != value:
            raise ValueError("Référence de secret déjà renseignée avec une autre valeur.")
        target[key] = value
    return resolved


def runtime_profiles(profile, observations, credential_outputs, secret_result):
    """Références cohérentes pour l'initialisation SQL et le worker, sans mots de passe."""
    app = validate(profile)
    gc, aw = profile["gcp"], profile["aws"]
    # Réutiliser les contrôles des générateurs, dont Ready/Synced et la région.
    source_address = gcp.observed_endpoint(gc, observations["cloudsql"])
    target_address = aws.observed_endpoint(aw, observations["rds"])
    refs = output_value(credential_outputs, "aws_secret_arns")
    gcp_secret = output_value(credential_outputs, "gcp_runtime_secret")
    if set(refs) != ROLES or aw["runtime_secret_arn"] != refs["runtime"] or \
            gc["gcp_runtime"]["password_secret"] != gcp_secret or secret_result.get("app") != app or \
            secret_result.get("initialized") is not True or gc["gcp_runtime"]["password_version"] != secret_result.get("gcp_password_version"):
        raise ValueError("Les références et versions doivent provenir des mêmes sorties de recette.")
    for role, arn in refs.items():
        if not isinstance(arn, str) or not re.fullmatch(
                rf"arn:aws:secretsmanager:{aws.REGION}:{aws.ACCOUNT}:secret:cnp/failover/{app}/{role}-[A-Za-z0-9]{{6}}", arn):
            raise ValueError("ARN de secret géré incohérent.")
    for ca in (gc["gcp_runtime"]["database_ca_pem"], aw["database_ca_pem"]):
        if not isinstance(ca, str) or len(ca) > 65536:
            raise ValueError("CA publique réelle requise pour les profils SQL.")
        ssl.create_default_context(cadata=ca)
    target_secret = refs["target-admin"]
    source = {"host": source_address,
        "secret_arn": refs["source-admin"], "ca_pem": gc["gcp_runtime"]["database_ca_pem"]}
    target = {"host": target_address, "secret_arn": target_secret, "ca_pem": aw["database_ca_pem"]}
    contract = postgres_contract.encode(gc["sql_contract"])
    bootstrap = {"app": app, "profile": contract, "source": source, "target": target,
        "runtime_secret_arn": refs["runtime"], "bootstrap_secret_arn": refs["bootstrap"],
        "subscription_ca_path_on_rds": profile["automation"]["subscription_ca_path_on_rds"]}
    for key in ("subscription_tls_mode", "acknowledge_wireguard_subscriber_trust"):
        if key in profile["automation"]:
            bootstrap[key] = profile["automation"][key]
    return bootstrap


def automation_profile(profile, observations, credentials, secret_result):
    base = runtime_profiles(profile, observations, credentials, secret_result)
    gcp.dns(profile["gcp"])
    health = observations["healthcheck"]
    expected = base["app"] + "-failover"
    conditions = {c.get("type"): c.get("status") for c in health.get("status", {}).get("conditions", [])}
    if health.get("kind") != "HealthCheck" or health.get("metadata", {}).get("name") != expected or \
            conditions.get("Ready") != "True" or conditions.get("Synced") != "True":
        raise ValueError("HealthCheck Ready/Synced de cette application requis.")
    provider = health.get("status", {}).get("atProvider", {})
    check_id = provider.get("id") or health.get("metadata", {}).get("annotations", {}).get("crossplane.io/external-name")
    if not isinstance(check_id, str) or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", check_id):
        raise ValueError("Identifiant réel Route53 requis.")
    # Vérifier également la cible de santé observée, pas seulement son nom.
    if provider.get("ipAddress") != profile["gcp"]["gcp_lb_ip"] or provider.get("fqdn") != base["app"] + ".apps.mooroon5.fr" or \
            provider.get("resourcePath") != profile["gcp"].get("readiness_path", "/health") or provider.get("enableSni") is not True or \
            provider.get("type") != "HTTPS" or provider.get("port") != 443:
        raise ValueError("Le contrôle observé doit viser l'IP GCP et le Host/SNI de l'app.")
    app = {key: base[key] for key in ("app", "profile", "source", "target")}
    if "readiness_path" in profile["gcp"]:
        app["readiness_path"] = profile["gcp"]["readiness_path"]
    app.update(hostname=base["app"] + ".apps.mooroon5.fr", gcp_lb_ip=profile["gcp"]["gcp_lb_ip"],
        alarm_name=worker.ALARM_PREFIX + base["app"], health_check_id=check_id)
    for key, observed_key, name, threshold in [("routing_latch_id", "routing_latch", "-failover-latch-http", None),
            ("primary_health_check_id", "primary_healthcheck", "-failover-primary-health", 2)]:
        observed = observations[observed_key]
        conditions = {c.get("type"): c.get("status") for c in observed.get("status", {}).get("conditions", [])}
        actual = observed.get("status", {}).get("atProvider", {})
        identifier = actual.get("id") or observed.get("metadata", {}).get("annotations", {}).get("crossplane.io/external-name")
        expected_type = "CALCULATED" if threshold is not None else "HTTPS"
        if observed.get("kind") != "HealthCheck" or observed.get("metadata", {}).get("name") != base["app"] + name or \
                conditions.get("Ready") != "True" or conditions.get("Synced") != "True" or \
                actual.get("type") != expected_type or (threshold is not None and actual.get("childHealthThreshold") != threshold) or \
                not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", identifier):
            raise ValueError("Verrou et contrôle primaire Ready/Synced réellement observés requis.")
        app[key] = identifier
    parent = observations["primary_healthcheck"]["status"]["atProvider"]
    latch = observations["routing_latch"]["status"]["atProvider"]
    if set(parent.get("childHealthchecks", [])) != {check_id, app["routing_latch_id"]} or \
            latch.get("childHealthchecks") or parent.get("invertHealthcheck", False) or parent.get("disabled", False) or latch.get("disabled") is not True or \
            any(latch.get(key) != provider.get(key) for key in ("ipAddress", "fqdn", "resourcePath", "enableSni", "port")):
        raise ValueError("Association des contrôles DNS différente du contrat de cette app.")
    tfvars = {key: profile["automation"][key] for key in ("worker_image", "ecs_cluster_arn", "ecs_security_group_id", "public_subnet_ids")}
    if not isinstance(tfvars["worker_image"], str) or not re.fullmatch(
            rf"{aws.ACCOUNT}\.dkr\.ecr\.{aws.REGION}\.amazonaws\.com/cnp-failover-apps@sha256:[a-f0-9]{{64}}", tfvars["worker_image"]) or \
            not isinstance(tfvars["ecs_cluster_arn"], str) or not re.fullmatch(
                rf"arn:aws:ecs:{aws.REGION}:{aws.ACCOUNT}:cluster/[a-zA-Z0-9_-]+", tfvars["ecs_cluster_arn"]) or \
            not isinstance(tfvars["ecs_security_group_id"], str) or not re.fullmatch(r"sg-[a-f0-9]{8,17}", tfvars["ecs_security_group_id"]) or \
            not isinstance(tfvars["public_subnet_ids"], list) or len(tfvars["public_subnet_ids"]) < 2 or \
            any(not isinstance(subnet, str) or not re.fullmatch(r"subnet-[a-f0-9]{8,17}", subnet) for subnet in tfvars["public_subnet_ids"]):
        raise ValueError("Image par digest et observations ECS/réseau réelles requises.")
    return {"worker-config.json": {"applications": [app]}, "bootstrap-config.json": base}


def write_package(output, candidates, review):
    if output.exists() and any(output.iterdir()):
        raise ValueError("Dossier de préparation vide requis.")
    output.mkdir(parents=True, exist_ok=True)
    for path, value in candidates.items():
        target = output / "candidate" / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    (output / "review.json").write_text(json.dumps(review, indent=2) + "\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stage", choices=STAGES)
    parser.add_argument("--profile", type=Path, required=True)
    # Racine du config-repo : explicite, ce script ne vit plus dedans (déplacé dans le portail le 08/11/2026).
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--observations", type=Path)
    parser.add_argument("--credentials-outputs", type=Path)
    parser.add_argument("--secret-result", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        profile = document(args.profile)
        if args.credentials_outputs and args.secret_result:
            profile = resolve_credentials(profile, document(args.credentials_outputs), document(args.secret_result))
        app = validate(profile)
        root, output = args.repo_root.resolve(), args.output.resolve()
        for watched in ("apps", "infra", "argocd", "platform", ".git"):
            if output == root/watched or root/watched in output.parents:
                raise ValueError("Ne jamais rendre directement dans un chemin GitOps actif.")
        revision = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
        if not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise ValueError("Révision Git explicite requise.")
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--",
            f"apps/{app}/crossplane/prod", "platform/application-routing"], text=True, capture_output=True, check=True).stdout
        if dirty.strip():
            raise ValueError("Baseline de production modifiée localement : la relire avant de préparer un remplacement.")
        observations = document(args.observations) if args.observations else {}
        baseline_paths = {}
        if args.stage == "secrets":
            if not args.credentials_outputs:
                raise ValueError("Sorties des conteneurs requis.")
            candidates = {"initialize-secrets-config.json": credentials_profile(profile, document(args.credentials_outputs))}
        elif args.stage in {"bootstrap", "automation"}:
            if not args.credentials_outputs or not args.secret_result:
                raise ValueError("Sorties des conteneurs et résultat expurgé d'initialisation requis.")
            credentials, result = document(args.credentials_outputs), document(args.secret_result)
            if args.stage == "automation":
                candidates = automation_profile(profile, observations, credentials, result)
            else:
                candidates = {"bootstrap-config.json": runtime_profiles(profile, observations, credentials, result)}
        else:
            path = f"apps/{app}/crossplane/prod/kustomization.yaml"
            baseline = document(root/path)
            baseline_paths[path] = hashlib.sha256((root/path).read_bytes()).hexdigest()
            urlmap = None
            if args.stage == "runtime":
                route_path = "platform/application-routing/urlmap.yaml"
                urlmap = document(root/route_path)
                baseline_paths[route_path] = hashlib.sha256((root/route_path).read_bytes()).hexdigest()
            candidates = build(profile, args.stage, baseline, observations, urlmap,
                document(args.credentials_outputs) if args.credentials_outputs else None,
                document(args.secret_result) if args.secret_result else None)
        review = {"app": app, "stage": args.stage, "base_revision": revision, "baseline_sha256": baseline_paths,
            "candidate_paths": sorted(candidates), "published": False, "cloud_called": False,
            "requires_explicit_approval": True,
            "note": "Paquet de modifications partielles, à comparer à la baseline récente et publier par le circuit prod approuvé. Aucun fichier conservé n'est à supprimer."}
        write_package(output, candidates, review)
        print(json.dumps({"app": app, "stage": args.stage, "files_prepared": len(candidates), "published": False}))
        return 0
    except Exception:
        print("Préparation refusée : profil, observations ou baseline incomplets ; aucun détail sensible affiché.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
