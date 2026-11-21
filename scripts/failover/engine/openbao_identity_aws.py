"""Rôle d'exécution ECS propre à une application du secours AWS. Requête JSON sur stdin, ARN du rôle sur stdout.

Appelé par le provisionneur des identités runtime (jamais par le portail : il n'a aucun droit IAM). Rejouable : le nom est
déterministe (même calcul que `awsRuntimeRole()` côté portail), un rôle existant est vérifié avant d'être complété. Le
rôle n'est déclaré prêt qu'après relecture complète (chemin, limite de droits, confiance, tags, politique unique) et une
simulation IAM : la lecture des variables de l'app est autorisée, celle d'une autre app et celle des secrets
d'administration de la base sont refusées. Aucune valeur de secret n'est jamais lue.

Aucune opération cloud à l'import ; execute() accepte des clients simulés.
"""
import hashlib
import json
import re
import sys
import time

PATH = "/cnp-runtime/"
POLICY = "cnp-runtime-exec"
MANAGED_BY = "cnp-openbao-provisioner"
APP = re.compile(r"[a-z][a-z0-9-]{0,38}[a-z0-9]")


class NotReady(Exception):
    """Le rôle existe mais IAM ne le voit pas encore partout (cohérence à terme)."""


def _code(error):
    return getattr(error, "response", {}).get("Error", {}).get("Code")


def role_name(app):
    return f"cnp-{hashlib.sha256(f'{app}/prod'.encode()).hexdigest()[:20]}-exec"


def trust(account):
    return {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "ecs-tasks.amazonaws.com"}, "Action": "sts:AssumeRole",
        "Condition": {"StringEquals": {"aws:SourceAccount": account}}}]}


def policy(app, account, region):
    secrets = f"arn:aws:secretsmanager:{region}:{account}:secret:cnp/failover/{app}"
    return {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["ecr:GetAuthorizationToken"], "Resource": "*"},
        {"Effect": "Allow", "Action": ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
         "Resource": f"arn:aws:ecr:{region}:{account}:repository/{app}"},
        {"Effect": "Allow", "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
         "Resource": f"arn:aws:logs:{region}:{account}:log-group:/ecs/*:*"},
        {"Effect": "Allow", "Action": ["secretsmanager:GetSecretValue"],
         "Resource": [f"{secrets}/env-*", f"{secrets}/runtime-*"]}]}


def _canonical(document):
    if isinstance(document, str):
        document = json.loads(document)
    return json.dumps(document, sort_keys=True, separators=(",", ":"))


def _validate(request):
    app, account, region, boundary = (request.get(key) for key in ("app", "account", "region", "boundary_arn"))
    if (not isinstance(app, str) or not APP.fullmatch(app)
            or not isinstance(account, str) or not re.fullmatch(r"\d{12}", account)
            or not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}-[a-z]+-\d", region)
            or boundary != f"arn:aws:iam::{account}:policy/cnp-runtime/cnp-runtime-exec-boundary"):
        raise ValueError("Paramètres du rôle AWS invalides.")
    return app, account, region, boundary


def _check(iam, app, account, region, boundary):
    """Relit le rôle et refuse tout écart : un rôle existant hors périmètre n'est jamais « réparé »."""
    name = role_name(app)
    role = iam.get_role(RoleName=name)["Role"]
    tags = {item["Key"]: item["Value"] for item in role.get("Tags", [])}
    if (role.get("Path") != PATH or role.get("Arn") != f"arn:aws:iam::{account}:role{PATH}{name}"
            or (role.get("PermissionsBoundary") or {}).get("PermissionsBoundaryArn") != boundary
            or _canonical(role.get("AssumeRolePolicyDocument")) != _canonical(trust(account))
            or tags.get("Application") != app or tags.get("Environment") != "prod" or tags.get("ManagedBy") != MANAGED_BY):
        raise ValueError("Rôle AWS existant hors du périmètre attendu.")
    attached = iam.list_attached_role_policies(RoleName=name).get("AttachedPolicies", [])
    inline = iam.list_role_policies(RoleName=name).get("PolicyNames", [])
    if attached or inline != [POLICY]:
        raise ValueError("Rôle AWS existant hors du périmètre attendu.")
    document = iam.get_role_policy(RoleName=name, PolicyName=POLICY)["PolicyDocument"]
    if _canonical(document) != _canonical(policy(app, account, region)):
        raise ValueError("Rôle AWS existant hors du périmètre attendu.")
    return role["Arn"]


def _probe(app, account, region):
    """Ressources simulées : jamais lues. L'autre app est un nom qui ne peut pas être `app`."""
    other = "cnp-isolation-probe" if app != "cnp-isolation-probe" else "cnp-isolation-probe-b"
    base = f"arn:aws:secretsmanager:{region}:{account}:secret:cnp/failover"
    return {f"{base}/{app}/env-000000000000-AbCdEf": "allowed",
            f"{base}/{app}/runtime-AbCdEf": "allowed",
            f"{base}/{other}/env-000000000000-AbCdEf": "denied",
            f"{base}/{app}/source-admin-AbCdEf": "denied",
            f"{base}/{app}/target-admin-AbCdEf": "denied"}


def _simulate(iam, arn, app, account, region):
    expected = _probe(app, account, region)
    try:
        results = iam.simulate_principal_policy(PolicySourceArn=arn, ActionNames=["secretsmanager:GetSecretValue"],
                                                ResourceArns=list(expected))["EvaluationResults"]
    except Exception as error:
        if _code(error) in {"NoSuchEntity", "NoSuchEntityException"}:
            raise NotReady() from None
        raise
    # Plusieurs ressources pour une action : AWS renvoie un seul résultat dont EvalResourceName est un gabarit
    # (arn:aws:secretsmanager:${Region}:...) et place les décisions par ressource dans ResourceSpecificResults
    # (forme relevée le 20/11/2026 sur le compte réel). Une ressource absente de la réponse compte comme refusée.
    decisions = {}
    for item in results:
        specific = item.get("ResourceSpecificResults") or []
        if specific:
            decisions.update({entry.get("EvalResourceName"): entry.get("EvalResourceDecision") for entry in specific})
        else:
            decisions[item.get("EvalResourceName")] = item.get("EvalDecision")
    for resource, wanted in expected.items():
        allowed = decisions.get(resource) == "allowed"
        if allowed != (wanted == "allowed"):
            # Autorisation manquante : propagation probable. Autorisation en trop : jamais acceptable.
            if wanted == "allowed":
                raise NotReady()
            raise ValueError("Isolation du rôle AWS non prouvée.")


def ensure(request, iam, sleep=time.sleep, attempts=8):
    app, account, region, boundary = _validate(request)
    name = role_name(app)
    # Création tentée d'emblée, sans GetRole préalable : pour un rôle absent, IAM évalue GetRole sur role/<nom> SANS le
    # chemin, que la politique du provisionneur (role/cnp-runtime/*) n'autorise pas → AccessDenied au lieu de
    # NoSuchEntity (relevé le 21/11/2026 sur le compte réel). Un rôle homonyme hors du chemin fait échouer la création
    # (EntityAlreadyExists, noms uniques) puis la relecture ci-dessous (AccessDenied) : refus, jamais d'adoption.
    try:
        iam.create_role(Path=PATH, RoleName=name, AssumeRolePolicyDocument=json.dumps(trust(account)),
                        PermissionsBoundary=boundary, MaxSessionDuration=3600,
                        Description=f"CNP secours AWS : execution ECS de {app} (variables)",
                        Tags=[{"Key": "Application", "Value": app}, {"Key": "Environment", "Value": "prod"},
                              {"Key": "ManagedBy", "Value": MANAGED_BY}])
    except Exception as create_error:
        if _code(create_error) != "EntityAlreadyExists":
            raise
    # Politique écrite avant la relecture : un rôle créé lors d'un essai interrompu est complété, jamais élargi
    # (la condition IAM sur la limite de droits interdit l'écriture sinon, et _check refuse tout autre écart).
    role = iam.get_role(RoleName=name)["Role"]
    tags = {item["Key"]: item["Value"] for item in role.get("Tags", [])}
    if tags.get("ManagedBy") != MANAGED_BY or tags.get("Application") != app or role.get("Path") != PATH:
        raise ValueError("Rôle AWS existant hors du périmètre attendu.")
    iam.put_role_policy(RoleName=name, PolicyName=POLICY, PolicyDocument=json.dumps(policy(app, account, region)))
    arn = _check(iam, app, account, region, boundary)
    for attempt in range(attempts):
        try:
            _simulate(iam, arn, app, account, region)
            return {"role_arn": arn}
        except NotReady:
            if attempt == attempts - 1:
                raise ValueError("Rôle AWS créé mais pas encore effectif, réessayez.") from None
            sleep(5)


def remove(request, iam):
    """Suppression de l'app : retire son rôle d'exécution, et seulement lui (chemin, étiquettes, aucune politique gérée).

    Un rôle absent n'est pas une erreur. Comme pour la création, IAM évalue GetRole sur un rôle absent sans son chemin,
    hors des droits du provisionneur : AccessDenied vaut donc « absent » ici (un homonyme hors de /cnp-runtime/ est de même
    illisible, et ne serait de toute façon jamais supprimé : DeleteRole est limité au chemin et à l'étiquette ManagedBy).
    """
    app, _account, _region, _boundary = _validate(request)
    name = role_name(app)
    try:
        role = iam.get_role(RoleName=name)["Role"]
    except Exception as error:
        if _code(error) in {"NoSuchEntity", "AccessDenied"}:
            return {"removed": False}
        raise
    tags = {item["Key"]: item["Value"] for item in role.get("Tags", [])}
    if (role.get("Path") != PATH or tags.get("ManagedBy") != MANAGED_BY or tags.get("Application") != app
            or tags.get("Environment") != "prod" or iam.list_attached_role_policies(RoleName=name).get("AttachedPolicies")):
        raise ValueError("Rôle AWS existant hors du périmètre attendu.")
    for name_ in iam.list_role_policies(RoleName=name).get("PolicyNames", []):
        iam.delete_role_policy(RoleName=name, PolicyName=name_)
    try:
        iam.delete_role(RoleName=name)
    except Exception as error:
        if _code(error) != "NoSuchEntity":
            raise
    return {"removed": True}


def main():
    try:
        import boto3
        request = json.load(sys.stdin)
        operation = {"ensure": ensure, "remove": remove}.get(request.get("operation"))
        if operation is None:
            raise ValueError("Opération inconnue.")
        if boto3.client("sts", region_name=request.get("region")).get_caller_identity()["Account"] != request.get("account"):
            raise ValueError("Compte AWS inattendu.")
        json.dump(operation(request, boto3.client("iam")), sys.stdout)
    except ValueError as error:
        # Messages écrits ici, sans paramètre de requête ni valeur : sûrs à remonter au portail.
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except Exception:
        # Les exceptions boto3 peuvent contenir des paramètres de requête : rien n'est imprimé.
        print("Provisionnement AWS indisponible ou refusé.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
