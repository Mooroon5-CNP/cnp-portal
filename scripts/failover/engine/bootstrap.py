import postgres_contract
#!/usr/bin/env python3
"""Préparer les bases managées de recette ; simulation sans réseau par défaut."""
import argparse
import ipaddress
import json
from pathlib import Path
import re
import ssl
import sys

import automation
import database
import replication_tls
from uuid import uuid4
from psycopg.conninfo import make_conninfo


def validate(config, operation):
    required = {"app", "profile", "source", "target", "runtime_secret_arn", "bootstrap_secret_arn", "subscription_ca_path_on_rds"}
    optional = {"subscription_tls_mode", "acknowledge_wireguard_subscriber_trust"}
    if not isinstance(config, dict) or not required <= set(config) or set(config) - required - optional or not postgres_contract.database_name(config["profile"]) or \
            not isinstance(config["app"], str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", config["app"]):
        raise ValueError("Profil SQL incomplet ou invalide.")
    sides = {"source"} if operation in {"prepare-source", "inspect-source"} else {"source", "target"} if operation in {"monitor", "verify-replication", "verify-native-tls", "subscribe", "restore-schema", "resync-schema", "failback-sync", "failback-reset"} else {"target"}
    for side in sides:
        spec = config[side]
        if not isinstance(spec, dict) or set(spec) != {"host", "secret_arn", "ca_pem"}:
            raise ValueError("Observation SQL et références de secrets requises.")
        if not isinstance(spec["ca_pem"], str) or len(spec["ca_pem"]) > 65536:
            raise ValueError("CA publique SQL invalide.")
        ssl.create_default_context(cadata=spec["ca_pem"])
        if not isinstance(spec["secret_arn"], str) or not re.fullmatch(
                rf"arn:aws:secretsmanager:eu-west-3:{automation.ACCOUNT}:secret:[a-zA-Z0-9!/_+=.@-]+", spec["secret_arn"]):
            raise ValueError("Secret administrateur du compte/région attendu requis.")
        if side == "source":
            if ipaddress.IPv4Address(spec["host"]) not in ipaddress.ip_network("10.189.0.0/16") or not spec["secret_arn"].startswith(
                    f"arn:aws:secretsmanager:eu-west-3:{automation.ACCOUNT}:secret:cnp/failover/{config['app']}/source-admin-"):
                raise ValueError("Source privée ou secret source incohérent.")
        elif not re.fullmatch(r"[a-z0-9-]+\.[a-z0-9]+\.eu-west-3\.rds\.amazonaws\.com", spec["host"]):
            raise ValueError("Endpoint RDS privé observé requis.")
    if operation == "create-target-runtime":
        check_secret(config, "runtime_secret_arn", "runtime")
    if operation in {"verify-native-tls", "subscribe"}:
        check_secret(config, "bootstrap_secret_arn", "bootstrap")
        mode = config.get("subscription_tls_mode", "server-ca")
        path = config["subscription_ca_path_on_rds"]
        if mode == "server-ca":
            if not isinstance(path, str) or not path.startswith("/") or ".." in Path(path).parts or any(ch.isspace() for ch in path):
                raise ValueError("Fournir un chemin de CA réellement disponible sur le serveur RDS.")
        elif mode != "wireguard-tls" or config.get("acknowledge_wireguard_subscriber_trust") is not True or path is not None:
            raise ValueError("Choix wireguard-tls explicite et sans faux chemin de CA requis.")
    return config


def check_secret(config, key, role):
    if not isinstance(config[key], str) or not re.fullmatch(
            rf"arn:aws:secretsmanager:eu-west-3:{automation.ACCOUNT}:secret:cnp/failover/{config['app']}/{role}-[A-Za-z0-9]{{6}}", config[key]):
        raise ValueError("Référence de secret géré invalide.")


def replication_dsn(config, secrets):
    values = json.loads(secrets.get_secret_value(SecretId=config["bootstrap_secret_arn"])["SecretString"])
    if values.get("app") != config["app"] or values.get("schema_version") != 1 or not isinstance(values.get("replication-password"), str):
        raise ValueError("Bootstrap de réplication incompatible.")
    tls = {"sslmode": "verify-ca", "sslrootcert": config["subscription_ca_path_on_rds"]} if config.get("subscription_tls_mode", "server-ca") == "server-ca" else {"sslmode": "require"}
    dsn = make_conninfo(host=config["source"]["host"], port=5432,
        dbname=postgres_contract.database_name(config["profile"]), user="cnp_replication",
        password=values["replication-password"], **tls, connect_timeout=automation.CONNECT_TIMEOUT, application_name="cnp-phase1-subscription")
    return replication_tls.validate_dsn(dsn, config["profile"], config.get("acknowledge_wireguard_subscriber_trust", False))


def execute(config, operation, secrets, sql=None):
    validate(config, operation)
    sql = sql or automation.SQL(secrets)
    profile = config["profile"]
    report = {}
    if operation == "prepare-source":
        with sql.connection(config, "source") as source:
            database.guard_bootstrap(source, source=True)
            database.install_schema(source, profile)
            if postgres_contract.is_introspected(profile):
                # Les tables appartiennent à l'application (cnp_runtime) : l'administrateur doit pouvoir les administrer.
                database.adopt_runtime_tables(source)
                # Avant tout droit et toute publication : un schéma non pris en charge doit arrêter ici, sans rien modifier.
                report = database.prepare_source_schema(source)
            database.restrict_cloudsql_runtime(source)
            database.configure_runtime(source, standby=False, profile=profile)
            database.publisher(source, profile)
    elif operation == "inspect-source":
        # Lecture seule, sans effet : le portail attend ainsi que l'application ait créé son schéma.
        with sql.connection(config, "source") as source:
            return {**database.inspect_source(source), "operation": operation, "completed": True}
    elif operation == "restore-schema":
        # Lit le schéma de la source, ne l'écrit que sur la cible, avant tout abonnement.
        with sql.connection(config, "source") as source, sql.connection(config, "target") as target:
            return {**database.copy_schema(source, target, lambda: sql.dump_schema(config, "source")), "operation": operation, "completed": True}
    elif operation == "resync-schema":
        # Après une mise à jour de l'application : si sa migration a changé le schéma de GCP, la copie AWS est vidée ; le
        # portail rejoue ensuite l'initialisation habituelle (publication, schéma, abonnement avec recopie des données).
        with sql.connection(config, "source") as source, sql.connection(config, "target") as target:
            expected, present = database.schema_fingerprint(source), database.schema_fingerprint(target)
            if expected == present and target.execute("SELECT 1 FROM pg_subscription WHERE subname=%s", (database.SUBSCRIPTION,)).fetchone():
                return {"operation": operation, "completed": True, "resynced": False, "schema_fingerprint": expected}
            database.reset_target(target)
            return {"operation": operation, "completed": True, "resynced": True, "schema_fingerprint": expected}
    elif operation in {"failback-sync", "failback-reset"}:
        # Retour manuel vers GCP, après une bascule : copie AWS → GCP et réouverture de GCP, puis remise à zéro de la copie
        # AWS (reconstruite ensuite depuis GCP par l'initialisation habituelle). Réservé aux schémas lus dans la base.
        if not postgres_contract.is_introspected(profile):
            raise ValueError("Retour vers GCP réservé aux profils dont le schéma est lu dans la base.")
        with sql.connection(config, "source") as source, sql.connection(config, "target") as target:
            result = database.failback_sync(source, target, profile) if operation == "failback-sync" else database.failback_reset_target(source, target)
            return {**result, "operation": operation, "completed": True}
    elif operation == "create-target-runtime":
        data = json.loads(secrets.get_secret_value(SecretId=config["runtime_secret_arn"])["SecretString"])
        if data.get("username") != database.RUNTIME:
            raise ValueError("Secret runtime incompatible.")
        with sql.connection(config, "target") as target:
            database.create_target_runtime(target, data.get("password"))
    elif operation == "prepare-target":
        with sql.connection(config, "target") as target:
            database.guard_bootstrap(target)
            database.install_schema(target, profile)
            database.configure_runtime(target, standby=True, profile=profile)
    elif operation in {"verify-native-tls", "subscribe"}:
        dsn = replication_dsn(config, secrets)
        with sql.connection(config, "target") as target:
            result = database.native_tls_probe(target, dsn, profile,
                acknowledge_wireguard_subscriber_trust=config.get("acknowledge_wireguard_subscriber_trust", False))
            if operation == "subscribe":
                database.subscribe(target, dsn, profile)
            return {**result, "subscription_created": operation == "subscribe"}
    elif operation == "verify-replication":
        with sql.connection(config, "source") as source, sql.connection(config, "target") as target:
            login = target.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname='cnp_runtime'").fetchone()
            if login is None or login[0] or target.execute("SELECT 1 FROM public.cnp_recovery WHERE singleton").fetchone():
                raise ValueError("Cible déjà ouverte ou reprise engagée ; vérification initiale interdite.")
            marker = uuid4()
            source.execute("INSERT INTO public.replication_barrier(id) VALUES (%s)", (marker,))
            database.wait_replay(target, marker, profile=profile)
            return {**database.replication_status(source, target, profile), "fresh_write_replayed": True}
    elif operation == "monitor":
        with sql.connection(config, "source") as source, sql.connection(config, "target") as target:
            return database.replication_status(source, target, profile)
    else:
        with sql.connection(config, "target") as target:
            return database.progress(target, profile)
    return {"operation": operation, "completed": True, **report}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["prepare-source", "inspect-source", "restore-schema", "resync-schema", "failback-sync", "failback-reset", "create-target-runtime", "prepare-target", "verify-native-tls", "subscribe", "monitor", "verify-replication", "status"])
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        config = validate(json.loads(args.config.read_text()), args.operation)
        if not args.execute:
            print(json.dumps({"app": config["app"], "operation": args.operation, "simulation": True,
                "cloud_called": False, "sql_executed": False}))
            return 0
        import boto3
        from botocore.config import Config
        session = boto3.Session(region_name="eu-west-3")
        settings = Config(connect_timeout=3, read_timeout=5, retries={"mode": "standard", "total_max_attempts": 2})
        if session.client("sts", config=settings).get_caller_identity()["Account"] != automation.ACCOUNT:
            raise ValueError("Compte AWS inattendu.")
        print(json.dumps(execute(config, args.operation, session.client("secretsmanager", config=settings))))
        return 0
    except Exception:
        print("Bootstrap interrompu ; aucun secret affiché. Vérifier droits, état SQL et confiance TLS côté RDS.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
