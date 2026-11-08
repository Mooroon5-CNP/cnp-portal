#!/usr/bin/env python3
"""Secrets d'une app en régime plateforme, sans aucune CLI (ni kubectl, ni gcloud, ni Terraform).

Même idiome qu'Azure : le **Secret Kubernetes est l'origine** (c'est lui que lit Crossplane pour Cloud SQL et RDS). Les lecteurs hors du
cluster lisent chacun le gestionnaire de secrets de leur cloud, d'où deux copies :
- AWS Secrets Manager, `cnp/failover/<app>/<rôle>` : la copie qui survit à une panne GCP (bootstrap, worker, ECS) ;
- Google Secret Manager, `<app>-prod-runtime` : le mot de passe que lit Cloud Run.

Conteneur et valeur naissent ensemble, par l'API (décision D1). Rien n'est jamais régénéré ni remplacé : une valeur existante différente
arrête tout (aucune rotation implicite), et un objet existant qui n'a pas été créé par la plateforme pour cette app est refusé.
Aucune valeur n'est imprimée, journalisée ou renvoyée.

Le chemin historique du pilote (`initialize_secrets.py`, pile Terraform `credentials/`) a été retiré le 07/11/2026.
"""
import base64
import json
import re
import secrets
from uuid import NAMESPACE_URL, uuid5

ACCOUNT = "804210702561"
PROJECT = "cnp-terraform-512313"
REGION = "eu-west-3"
GCP_LOCATION = "europe-west9"
NAMESPACE = "crossplane-system"
MANAGED_BY = "cnp-platform"
# Les quatre premières sont celles du pilote (même contenu du conteneur bootstrap, lu tel quel par bootstrap.py).
KEYS = ("admin-password", "runtime-password", "replication-password", "target-runtime-password", "target-admin-password")
BOOTSTRAP_KEYS = KEYS[:4]
ROLES = ("bootstrap", "source-admin", "runtime", "target-admin")


class Exists(Exception):
    """L'objet a été créé entre la lecture et la création (autre opérateur, ou réponse perdue après une écriture réussie)."""


def validate(config):
    if not isinstance(config, dict) or set(config) != {"app", "kubernetes_secret", "gcp_runtime_service_account"}:
        raise ValueError("Profil de secrets plateforme invalide.")
    app = config["app"]
    if not isinstance(app, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", app):
        raise ValueError("Nom d'application invalide.")
    if config["kubernetes_secret"] != f"cnp-{app}-sql":
        raise ValueError("Secret Kubernetes inattendu.")
    if not isinstance(config["gcp_runtime_service_account"], str) or not re.fullmatch(
            rf"[a-z0-9-]+@{PROJECT}\.iam\.gserviceaccount\.com", config["gcp_runtime_service_account"]):
        raise ValueError("Compte runtime existant du projet courant requis.")
    return app


def labels(app):
    return {"cnp.io/application": app, "cnp.io/environment": "prod", "cnp.io/credentials": "platform"}


def origin(kube, config):
    """Valeurs de l'app : lues dans le Secret Kubernetes s'il existe, sinon générées et créées (création seule, jamais de remplacement)."""
    app, name = config["app"], config["kubernetes_secret"]
    current = kube.get(name)
    if current is None:
        values = {key: secrets.token_urlsafe(48) for key in KEYS}
        manifest = {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": name, "namespace": NAMESPACE, "labels": labels(app)},
            "data": {key: base64.b64encode(value.encode()).decode() for key, value in values.items()}}
        try:
            kube.create(manifest)
            return values
        except Exists:
            # Un autre opérateur l'a créé : ce sont ses valeurs qui font foi, les nôtres sont abandonnées sans avoir servi.
            current = kube.get(name)
            if current is None:
                raise ValueError("Secret Kubernetes introuvable après conflit de création.") from None
    found = current.get("metadata", {}).get("labels") or {}
    data = current.get("data") or {}
    if any(found.get(key) != value for key, value in labels(app).items()) or set(data) != set(KEYS):
        raise ValueError("Secret Kubernetes existant incompatible ; ne pas remplacer des identifiants actifs.")
    values = {key: base64.b64decode(data[key]).decode() for key in KEYS}
    if any(len(value) < 24 for value in values.values()):
        raise ValueError("Secret Kubernetes existant incompatible ; ne pas remplacer des identifiants actifs.")
    return values


def documents(app, values):
    """Contenu de chaque conteneur AWS, aux formats déjà lus par bootstrap.py et par le worker (`username`/`password`)."""
    return {
        "bootstrap": {"app": app, "schema_version": 1, **{key: values[key] for key in BOOTSTRAP_KEYS}},
        "source-admin": {"username": "postgres", "password": values["admin-password"]},
        "runtime": {"username": "cnp_runtime", "password": values["target-runtime-password"]},
        "target-admin": {"username": "cnp_owner", "password": values["target-admin-password"]},
    }


def aws_code(exc):
    return getattr(exc, "response", {}).get("Error", {}).get("Code")


def aws_copy(client, app, role, document):
    name = f"cnp/failover/{app}/{role}"
    text = json.dumps(document, sort_keys=True)
    token = str(uuid5(NAMESPACE_URL, f"cnp/{app}/platform-{role}-v1"))
    meta = aws_describe(client, name)
    if meta is None:
        try:
            arn = client.create_secret(Name=name, SecretString=text, ClientRequestToken=token, Tags=[
                {"Key": "Project", "Value": "CNP"}, {"Key": "Application", "Value": app},
                {"Key": "Environment", "Value": "prod"}, {"Key": "ManagedBy", "Value": MANAGED_BY}])["ARN"]
            return aws_arn(app, role, arn)
        except Exception:
            # Création concurrente, ou réponse perdue après une création réussie : relire, ne jamais régénérer.
            meta = aws_describe(client, name)
            if meta is None:
                raise
    tags = {tag["Key"]: tag["Value"] for tag in meta.get("Tags", [])}
    if meta.get("DeletedDate") or tags.get("Application") != app or tags.get("ManagedBy") != MANAGED_BY:
        raise ValueError("Conteneur AWS existant non créé par la plateforme pour cette app, ou en cours de suppression.")
    arn = aws_arn(app, role, meta["ARN"])
    try:
        old = client.get_secret_value(SecretId=arn)["SecretString"]
    except Exception as exc:
        if aws_code(exc) != "ResourceNotFoundException" or meta.get("VersionIdsToStages"):
            raise
        old = None
    if old is None:
        client.put_secret_value(SecretId=arn, ClientRequestToken=token, SecretString=text)
    elif json.loads(old) != document:
        raise ValueError("Valeur AWS existante différente ; aucune rotation implicite.")
    return arn


def aws_describe(client, name):
    try:
        return client.describe_secret(SecretId=name)
    except Exception as exc:
        if aws_code(exc) == "ResourceNotFoundException":
            return None
        raise


def aws_arn(app, role, arn):
    if not isinstance(arn, str) or not re.fullmatch(rf"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:cnp/failover/{app}/{role}-[A-Za-z0-9]{{6}}", arn):
        raise ValueError("ARN de conteneur AWS inattendu.")
    return arn


def gcp_copy(gsm, config, password):
    """Secret lu par Cloud Run : métadonnées, une seule version active et droit de lecture du compte runtime. Renvoie le numéro de version."""
    app = config["app"]
    parent = f"projects/{PROJECT}"
    name = f"{parent}/secrets/{app}-prod-runtime"
    wanted = {"application": app, "environment": "prod", "managed-by": MANAGED_BY}
    meta = gsm.get_secret(name)
    if meta is None:
        try:
            gsm.create_secret(parent, f"{app}-prod-runtime", wanted, GCP_LOCATION)
        except Exists:
            pass
        meta = gsm.get_secret(name)
    if meta is None or any(meta["labels"].get(key) != value for key, value in wanted.items()):
        raise ValueError("Secret GCP existant non créé par la plateforme pour cette app.")
    versions = gsm.list_versions(name)
    enabled = [version for version in versions if version["state"] == "ENABLED"]
    if enabled:
        latest = max(enabled, key=lambda version: int(version["name"].rsplit("/", 1)[1]))
        if gsm.access(latest["name"]) != password:
            raise ValueError("Valeur GCP existante différente ; aucune rotation implicite.")
        number = latest["name"].rsplit("/", 1)[1]
    elif versions:
        raise ValueError("Versions GCP désactivées ou détruites présentes ; intervention explicite requise.")
    else:
        number = gsm.add_version(name, password).rsplit("/", 1)[1]
    member, role = f"serviceAccount:{config['gcp_runtime_service_account']}", "roles/secretmanager.secretAccessor"
    policy = gsm.get_policy(name)
    if not any(binding["role"] == role and member in binding["members"] for binding in policy["bindings"]):
        bindings = [dict(binding, members=list(binding["members"])) for binding in policy["bindings"]]
        match = next((binding for binding in bindings if binding["role"] == role), None)
        if match:
            match["members"].append(member)
        else:
            bindings.append({"role": role, "members": [member]})
        # L'etag fait échouer l'écriture si la politique a changé depuis la lecture : aucun droit d'autrui n'est écrasé.
        gsm.set_policy(name, {"bindings": bindings, "etag": policy["etag"]})
    return number


def initialize(config, kube, aws_client, gsm):
    """Origine puis copies, dans cet ordre. Relançable : chaque étape réutilise ce qui existe et refuse ce qui diffère."""
    app = validate(config)
    values = origin(kube, config)
    arns = {role: aws_copy(aws_client, app, role, document) for role, document in documents(app, values).items()}
    version = gcp_copy(gsm, config, values["runtime-password"])
    return {
        "secrets": {"app": app, "initialized": True, "gcp_password_version": version,
                    "kubernetes_secret": config["kubernetes_secret"], "passwords_printed": False},
        # Même forme que les sorties de l'ancienne pile Terraform `credentials/`, que lisent les générateurs.
        "credentials": {"aws_secret_arns": {"value": arns}, "gcp_runtime_secret": {"value": f"projects/{PROJECT}/secrets/{app}-prod-runtime"}},
    }


def remove(config, kube, aws_client, gsm):
    """Suppression de l'app : ses secrets disparaissent des trois emplacements. Même règle qu'à la création, à l'envers : un objet
    qui n'a pas été créé par la plateforme pour cette app est refusé, jamais supprimé. Absent = déjà supprimé.
    Les conteneurs AWS sont supprimés sans délai de récupération : sinon leur nom resterait bloqué 7 à 30 jours."""
    app = validate(config)
    removed = []
    for role in ROLES:
        name = f"cnp/failover/{app}/{role}"
        meta = aws_describe(aws_client, name)
        if meta is None:
            continue
        tags = {tag["Key"]: tag["Value"] for tag in meta.get("Tags", [])}
        if tags.get("Application") != app or tags.get("ManagedBy") != MANAGED_BY:
            raise ValueError("Conteneur AWS non créé par la plateforme pour cette app : suppression refusée.")
        aws_client.delete_secret(SecretId=meta["ARN"], ForceDeleteWithoutRecovery=True)
        removed.append(name)
    name = f"projects/{PROJECT}/secrets/{app}-prod-runtime"
    meta = gsm.get_secret(name)
    if meta is not None:
        if meta["labels"].get("application") != app or meta["labels"].get("managed-by") != MANAGED_BY:
            raise ValueError("Secret GCP non créé par la plateforme pour cette app : suppression refusée.")
        gsm.delete_secret(name)
        removed.append(name)
    current = kube.get(config["kubernetes_secret"])
    if current is not None:
        found = current.get("metadata", {}).get("labels") or {}
        if any(found.get(key) != value for key, value in labels(app).items()):
            raise ValueError("Secret Kubernetes non créé par la plateforme pour cette app : suppression refusée.")
        kube.delete(config["kubernetes_secret"])
        removed.append(f"{NAMESPACE}/{config['kubernetes_secret']}")
    return {"removed": removed}


# --- Base Cloud SQL d'un déploiement sans failover (dev GCP) -------------------------------------------------------------------
# Un seul mot de passe (l'utilisateur cnp_runtime de l'app) : Secret Kubernetes lu par Crossplane pour créer l'utilisateur Cloud SQL,
# copié dans Secret Manager pour Cloud Run. Noms et étiquettes propres à l'environnement : jamais ceux d'une app failover.
APP_ENVIRONMENTS = ("dev",)


def app_sql_names(app, environment):
    if not isinstance(app, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", app) or environment not in APP_ENVIRONMENTS:
        raise ValueError("Application ou environnement invalide pour une base Cloud SQL.")
    name = f"{app}-{environment}"
    return {"kubernetes_secret": f"cnp-{name}-sql", "gcp_secret": f"{name}-db-password",
            "labels": {"cnp.io/application": app, "cnp.io/environment": environment, "cnp.io/credentials": "app-sql"},
            "gcp_labels": {"application": app, "environment": environment, "managed-by": MANAGED_BY}}


def app_sql_initialize(app, environment, service_account, kube, gsm):
    """Crée (une seule fois) le mot de passe de la base de l'app, puis sa copie Secret Manager lisible par Cloud Run. Relançable :
    un secret existant de la plateforme est réutilisé, un objet étranger est refusé, aucune valeur n'est jamais remplacée."""
    names = app_sql_names(app, environment)
    if not re.fullmatch(rf"[a-z0-9-]+@{PROJECT}\.iam\.gserviceaccount\.com", service_account or ""):
        raise ValueError("Compte runtime existant du projet courant requis.")
    current = kube.get(names["kubernetes_secret"])
    if current is None:
        password = secrets.token_urlsafe(48)
        try:
            kube.create({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
                "metadata": {"name": names["kubernetes_secret"], "namespace": NAMESPACE, "labels": names["labels"]},
                "data": {"runtime-password": base64.b64encode(password.encode()).decode()}})
        except Exists:
            current = kube.get(names["kubernetes_secret"])
    if current is not None:
        found = current.get("metadata", {}).get("labels") or {}
        data = current.get("data") or {}
        if any(found.get(key) != value for key, value in names["labels"].items()) or set(data) != {"runtime-password"}:
            raise ValueError("Secret Kubernetes existant incompatible ; ne pas remplacer des identifiants actifs.")
        password = base64.b64decode(data["runtime-password"]).decode()
    parent, secret = f"projects/{PROJECT}", f"projects/{PROJECT}/secrets/{names['gcp_secret']}"
    meta = gsm.get_secret(secret)
    if meta is None:
        try:
            gsm.create_secret(parent, names["gcp_secret"], names["gcp_labels"], GCP_LOCATION)
        except Exists:
            pass
        meta = gsm.get_secret(secret)
    if meta is None or any(meta["labels"].get(key) != value for key, value in names["gcp_labels"].items()):
        raise ValueError("Secret GCP existant non créé par la plateforme pour cette app.")
    enabled = [version for version in gsm.list_versions(secret) if version["state"] == "ENABLED"]
    if enabled:
        latest = max(enabled, key=lambda version: int(version["name"].rsplit("/", 1)[1]))
        if gsm.access(latest["name"]) != password:
            raise ValueError("Valeur GCP existante différente ; aucune rotation implicite.")
    else:
        gsm.add_version(secret, password)
    member, role = f"serviceAccount:{service_account}", "roles/secretmanager.secretAccessor"
    policy = gsm.get_policy(secret)
    if not any(binding["role"] == role and member in binding["members"] for binding in policy["bindings"]):
        gsm.set_policy(secret, {"bindings": [*policy["bindings"], {"role": role, "members": [member]}], "etag": policy["etag"]})
    return {"kubernetes_secret": names["kubernetes_secret"], "gcp_secret": names["gcp_secret"], "initialized": True}


def app_sql_remove(app, environment, kube, gsm):
    """Suppression : les deux secrets de la base de l'app, seulement s'ils ont été créés par la plateforme pour elle."""
    names = app_sql_names(app, environment)
    removed = []
    secret = f"projects/{PROJECT}/secrets/{names['gcp_secret']}"
    meta = gsm.get_secret(secret)
    if meta is not None:
        if any(meta["labels"].get(key) != value for key, value in names["gcp_labels"].items()):
            raise ValueError("Secret GCP non créé par la plateforme pour cette app : suppression refusée.")
        gsm.delete_secret(secret)
        removed.append(secret)
    current = kube.get(names["kubernetes_secret"])
    if current is not None:
        found = current.get("metadata", {}).get("labels") or {}
        if any(found.get(key) != value for key, value in names["labels"].items()):
            raise ValueError("Secret Kubernetes non créé par la plateforme pour cette app : suppression refusée.")
        kube.delete(names["kubernetes_secret"])
        removed.append(f"{NAMESPACE}/{names['kubernetes_secret']}")
    return {"removed": removed}


def clients(kube_context=None):
    """Vrais clients, mêmes identités que l'initialisation."""
    import boto3
    from botocore.config import Config
    settings = Config(connect_timeout=3, read_timeout=10, retries={"mode": "standard", "total_max_attempts": 2})
    session = boto3.Session(region_name=REGION)
    if session.client("sts", config=settings).get_caller_identity()["Account"] != ACCOUNT:
        raise ValueError("Compte AWS inattendu.")
    return Kubernetes.from_environment(kube_context), session.client("secretsmanager", config=settings), SecretManager.from_environment()


def execute(config, kube_context=None):
    """Vrais clients : identités de l'environnement (pod du portail dans le cluster, ou poste de l'opérateur). Aucune CLI."""
    validate(config)
    import boto3
    from botocore.config import Config
    settings = Config(connect_timeout=3, read_timeout=10, retries={"mode": "standard", "total_max_attempts": 2})
    session = boto3.Session(region_name=REGION)
    if session.client("sts", config=settings).get_caller_identity()["Account"] != ACCOUNT:
        raise ValueError("Compte AWS inattendu.")
    return initialize(config, Kubernetes.from_environment(kube_context), session.client("secretsmanager", config=settings),
                      SecretManager.from_environment())


class Kubernetes:
    """Adaptateur minimal de l'API Kubernetes (bibliothèque officielle) : identité du pod dans le cluster, sinon kubeconfig local."""
    def __init__(self, api):
        self.api = api

    @classmethod
    def from_environment(cls, context=None):
        from kubernetes import client, config
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config(context=context)
        return cls(client.CoreV1Api())

    def get(self, name):
        from kubernetes.client.exceptions import ApiException
        try:
            secret = self.api.read_namespaced_secret(name, NAMESPACE)
        except ApiException as exc:
            if exc.status == 404:
                return None
            raise
        return self.api.api_client.sanitize_for_serialization(secret)

    def delete(self, name):
        from kubernetes.client.exceptions import ApiException
        try:
            self.api.delete_namespaced_secret(name, NAMESPACE)
        except ApiException as exc:
            if exc.status != 404:
                raise

    def create(self, manifest):
        from kubernetes.client.exceptions import ApiException
        try:
            self.api.create_namespaced_secret(NAMESPACE, manifest)
        except ApiException as exc:
            if exc.status == 409:
                raise Exists() from None
            raise


class SecretManager:
    """Adaptateur minimal de Google Secret Manager (bibliothèque officielle, identifiants par défaut de l'environnement)."""
    def __init__(self, client):
        self.client = client

    @classmethod
    def from_environment(cls):
        from google.cloud import secretmanager
        # REST plutôt que gRPC : le résolveur DNS embarqué par gRPC échoue sur certains réseaux (« Could not contact DNS
        # servers », constaté le 6/11/2026) alors que celui du système fonctionne ; les autres lectures GCP sont déjà en REST.
        return cls(secretmanager.SecretManagerServiceClient(transport="rest"))

    def get_secret(self, name):
        from google.api_core.exceptions import NotFound
        try:
            secret = self.client.get_secret(request={"name": name})
        except NotFound:
            return None
        return {"labels": dict(secret.labels)}

    def create_secret(self, parent, secret_id, labels, location):
        from google.api_core.exceptions import AlreadyExists
        try:
            self.client.create_secret(request={"parent": parent, "secret_id": secret_id, "secret": {
                "labels": labels, "replication": {"user_managed": {"replicas": [{"location": location}]}}}})
        except AlreadyExists:
            raise Exists() from None

    def list_versions(self, name):
        return [{"name": version.name, "state": version.state.name}
                for version in self.client.list_secret_versions(request={"parent": name, "filter": ""})]

    def access(self, version):
        return self.client.access_secret_version(request={"name": version}).payload.data.decode()

    def add_version(self, name, text):
        return self.client.add_secret_version(request={"parent": name, "payload": {"data": text.encode()}}).name

    def get_policy(self, name):
        policy = self.client.get_iam_policy(request={"resource": name})
        return {"bindings": [{"role": binding.role, "members": list(binding.members)} for binding in policy.bindings], "etag": policy.etag}

    def delete_secret(self, name):
        from google.api_core.exceptions import NotFound
        try:
            self.client.delete_secret(request={"name": name})
        except NotFound:
            pass

    def set_policy(self, name, policy):
        self.client.set_iam_policy(request={"resource": name, "policy": policy})
