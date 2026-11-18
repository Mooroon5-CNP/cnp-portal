"""Deliver portal variables to AWS Secrets Manager. JSON request on stdin, references on stdout.

The caller must never log the request or expose it in process arguments. No cloud
operation happens when this module is imported; execute() accepts a mock client.
"""
import hashlib
import json
import re
import sys
from uuid import NAMESPACE_URL, uuid5


def _aws_code(error):
    return getattr(error, "response", {}).get("Error", {}).get("Code")


def execute(request, client):
    app = request.get("app")
    values = request.get("values")
    generation = request.get("generation")
    region = request.get("region")
    if (not isinstance(app, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", app)
            or not isinstance(values, dict) or not 1 <= len(values) <= 50
            or not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f-]{36}", generation)
            or not isinstance(region, str) or not re.fullmatch(r"[a-z]{2}-[a-z]+-\d", region)):
        raise ValueError("Profil AWS des variables invalide.")
    references = []
    for key, value in values.items():
        if (not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or not isinstance(value, str) or len(value.encode()) > 8192):
            raise ValueError("Variable AWS invalide.")
        digest = hashlib.sha256(key.encode()).hexdigest()[:12]
        name = f"cnp/failover/{app}/env-{digest}"
        version = str(uuid5(NAMESPACE_URL, f"cnp/{app}/{generation}/{key}"))
        tags = [{"Key": "Application", "Value": app}, {"Key": "Environment", "Value": "prod"},
                {"Key": "ManagedBy", "Value": "cnp-portal-variables"}]
        try:
            existing = client.describe_secret(SecretId=name)
        except Exception as error:
            if _aws_code(error) != "ResourceNotFoundException":
                raise
            existing = None
        if existing is None:
            try:
                result = client.create_secret(Name=name, SecretString=value,
                                              ClientRequestToken=version, Tags=tags)
            except Exception as error:
                if _aws_code(error) != "ResourceExistsException":
                    raise
                existing = client.describe_secret(SecretId=name)
            else:
                arn = result["ARN"]
        if existing is not None:
            actual = {item["Key"]: item["Value"] for item in existing.get("Tags", [])}
            if (existing.get("DeletedDate") or actual.get("Application") != app
                    or actual.get("Environment") != "prod"
                    or actual.get("ManagedBy") != "cnp-portal-variables"):
                raise ValueError("Secret AWS existant hors du périmètre du portail.")
            arn = existing["ARN"]
            client.put_secret_value(SecretId=arn, SecretString=value, ClientRequestToken=version)
        if not re.fullmatch(rf"arn:aws:secretsmanager:{re.escape(region)}:\d{{12}}:secret:{re.escape(name)}-[A-Za-z0-9]{{6}}", arn):
            raise ValueError("ARN AWS du secret invalide.")
        references.append({"name": key, "valueFrom": f"{arn}:::{version}"})
    return references


def main():
    try:
        import boto3
        request = json.load(sys.stdin)
        client = boto3.client("secretsmanager", region_name=request.get("region"))
        json.dump(execute(request, client), sys.stdout)
    except Exception:
        # boto3 exceptions can include request parameters. Never print them.
        print("Livraison AWS des variables indisponible ou refusée.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
