#!/usr/bin/env python3
"""Worker AWS de phase 1. Simulation sans réseau par défaut ; le retour vers GCP n'est jamais automatique (opérations manuelles)."""
from __future__ import annotations
import postgres_contract

import argparse
from contextlib import ExitStack, closing, contextmanager
from datetime import datetime, timezone
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import ssl
import sys
import tempfile
import time
from uuid import uuid4

ACCOUNT = "626278345026"
REGION = "eu-west-3"
LEASE_SECONDS = 120
# Durée d'alarme exigée avant de basculer. 90 s à l'origine ; 30 s depuis le 06/11/2026 (choix de Gabriel) : la sonde
# (3 échecs à 10 s) et l'alarme (1 min sous le seuil) filtrent déjà les coupures brèves.
MIN_OUTAGE_SECONDS = 30
MAX_OBSERVATION_AGE = 600
MAX_HEALTHY_MESSAGE_AGE = 60

# Délai d'ouverture d'une connexion PostgreSQL. Mesuré le 6/11/2026 depuis ECS vers une Cloud SQL db-f1-micro à travers le
# tunnel : 4,9 à 5,9 s (CPU bridé + allers-retours TLS). À 5 s, les connexions échouaient une fois sur deux.
CONNECT_TIMEOUT = 20

# Configuration lue dans une table DynamoDB (CNP_CONFIG_TABLE), préfixe d'alarme propre à la plateforme, aucune limite à 10 apps.
# Le régime historique du pilote (configuration dans la définition de tâche, préfixe cnp-failover-) a été retiré le 07/11/2026.
PLATFORM = {"state_table": "cnp-failover-platform-state", "config_table": "cnp-failover-platform-config",
    "topic": "cnp-failover-platform", "alarm_prefix": "cnp-failover-platform-", "max_apps": 200}
APP_FIELDS = {"app", "profile", "hostname", "gcp_lb_ip", "alarm_name", "health_check_id", "routing_latch_id",
    "primary_health_check_id", "source", "target"}


class Blocked(Exception):
    """Code public constant ; jamais de secret ou d'exception fournisseur brute."""


def require(condition, code="INVALID_CONFIG"):
    if not condition:
        raise Blocked(code)


def config_hash(app):
    return hashlib.sha256(json.dumps(app, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def normalize(app):
    """Une valeur absente et une valeur nulle sont équivalentes : l'empreinte ne doit pas dépendre de l'outil qui écrit la configuration."""
    return {key: value for key, value in app.items() if value is not None}


def validate_application(app, alarm_prefix="cnp-failover-"):
    require(isinstance(app, dict) and set(app) - {"readiness_path"} == APP_FIELDS)
    name = app["app"]
    require(isinstance(name, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,38}[a-z0-9]", name))
    require(bool(postgres_contract.database_name(app["profile"])))
    require(isinstance(app.get("readiness_path", "/health"), str) and re.fullmatch(r"/[a-zA-Z0-9/_-]*", app.get("readiness_path", "/health")))
    require(app["hostname"] == name + ".apps.mooroon5.fr")
    require(app["alarm_name"] == alarm_prefix + name)
    require(isinstance(app["health_check_id"], str) and re.fullmatch(
        r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", app["health_check_id"]))
    for key in ("routing_latch_id", "primary_health_check_id"):
        require(isinstance(app[key], str) and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", app[key]))
    require(len({app[k] for k in ("health_check_id", "routing_latch_id", "primary_health_check_id")}) == 3)
    require(ipaddress.IPv4Address(app["gcp_lb_ip"]).is_global)
    for side in ("source", "target"):
        db = app[side]
        require(isinstance(db, dict) and set(db) == {"host", "secret_arn", "ca_pem"})
        require(isinstance(db["secret_arn"], str) and re.fullmatch(
            rf"arn:aws:secretsmanager:{REGION}:{ACCOUNT}:secret:[a-zA-Z0-9!/_+=.@-]+", db["secret_arn"]))
        require(isinstance(db["ca_pem"], str) and len(db["ca_pem"]) <= 65536)
        ssl.create_default_context(cadata=db["ca_pem"])
    require(ipaddress.IPv4Address(app["source"]["host"]) in ipaddress.ip_network("10.189.0.0/16"))
    require(isinstance(app["target"]["host"], str) and re.fullmatch(
        r"[a-z0-9-]+\.[a-z0-9]+\.eu-west-3\.rds\.amazonaws\.com", app["target"]["host"]))
    require(app["source"]["secret_arn"] != app["target"]["secret_arn"])
    return app


def validate(config, alarm_prefix="cnp-failover-", max_apps=10, minimum=1):
    require(isinstance(config, dict) and set(config) == {"applications"})
    apps = config["applications"]
    require(isinstance(apps, list) and minimum <= len(apps) <= max_apps)
    seen = set()
    for app in apps:
        validate_application(app, alarm_prefix)
        require(app["app"] not in seen)
        seen.add(app["app"])
    return apps


class ConfigTable:
    """Configuration déclarée des apps, publiée par GitOps : le worker la lit, il ne l'écrit jamais.

    Un enregistrement par app : `app` (clé) et `config` (la configuration d'une app, en JSON). Une configuration invalide
    est rapportée mais ne retire jamais les autres apps : la bascule d'une app ne dépend pas de l'erreur d'une autre.
    """
    def __init__(self, client, table, page_size=None):
        self.client, self.table, self.page_size = client, table, page_size

    def applications(self):
        apps, invalid, start = [], [], None
        while True:
            args = {"TableName": self.table, "ConsistentRead": True}
            if self.page_size:
                args["Limit"] = self.page_size
            if start:
                args["ExclusiveStartKey"] = start
            page = self.client.scan(**args)
            for raw in page.get("Items", []):
                name = raw.get("app", {}).get("S", "?")
                try:
                    require("S" in raw.get("config", {}) and len(raw["config"]["S"]) <= 200000)
                    app = normalize(json.loads(raw["config"]["S"]))
                    require(isinstance(app, dict) and app.get("app") == name)
                    apps.append(validate_application(app, PLATFORM["alarm_prefix"]))
                except Exception:
                    invalid.append(name)
            start = page.get("LastEvaluatedKey")
            if not start:
                return sorted(apps, key=lambda value: value["app"]), sorted(invalid)


def attribute(value):
    """Petit codec explicite pour les types utilisés, sans float/TTL de verrou."""
    if isinstance(value, bool):
        return {"BOOL": value}
    if isinstance(value, int):
        return {"N": str(value)}
    if isinstance(value, str):
        return {"S": value}
    raise ValueError("Type d'attribut non pris en charge.")


def item(values):
    return {key: attribute(value) for key, value in values.items()}


def decode(values):
    result = {}
    for key, value in values.items():
        if "BOOL" in value:
            result[key] = value["BOOL"]
        elif "N" in value:
            result[key] = int(value["N"])
        else:
            result[key] = value["S"]
    return result


def conditional_failure(exc):
    return getattr(exc, "response", {}).get("Error", {}).get("Code") == "ConditionalCheckFailedException"


# Notifications envoyées par e-mail (SNS) : seulement ce qui demande l'attention d'une personne (choix de Gabriel, 07/11/2026).
# Tous les changements d'état restent inscrits dans le journal DynamoDB (EVENT#…) ; les autres ne partent simplement plus.
NOTICES = {
    "CLOSING_GCP_ROUTE": "Panne de GCP confirmée : bascule vers AWS en cours.",
    "AWS_ACTIVE": "Bascule vers AWS terminée : l'application est servie par AWS.",
    "GCP_FENCED": "GCP est revenu et fermé aux écritures : le retour vers GCP peut être lancé depuis le portail.",
    "GCP_ACTIVE": "Retour vers GCP terminé : la surveillance est rétablie.",
    "CONFIG_CHANGED": "Configuration modifiée sans nouvelle vérification : le worker n'agit plus pour cette application.",
}
# Un blocage repasse chaque minute (règle de reprise) : au plus un e-mail par heure et par raison.
BLOCKED_NOTICE_INTERVAL = 3600


def notice(state):
    """Texte d'un e-mail, ou None si l'état ne se notifie pas."""
    if state in NOTICES:
        return NOTICES[state]
    if state.startswith("BLOCKED"):
        return f"Worker bloqué ({state}) : il réessaie chaque minute ; intervenir si le blocage dure."
    return None


def ascii_subject(text):
    """SNS n'accepte que de l'ASCII dans l'objet d'un e-mail (100 caractères au plus)."""
    import unicodedata
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return plain[:99]


class Store:
    """Contrôle, bail et journal atomique dans une table dédiée à la plateforme."""
    def __init__(self, client, table, topic, sns, clock=time.time):
        self.client, self.table, self.topic, self.sns, self.clock = client, table, topic, sns, clock

    def key(self, app, sk="CONTROL"):
        return item({"app": app, "record": sk})

    def control(self, app):
        return decode(self.client.get_item(TableName=self.table, Key=self.key(app), ConsistentRead=True).get("Item", {}))

    def configure(self, app):
        now = int(self.clock())
        self.client.put_item(TableName=self.table, Item=item({"app": app["app"], "record": "CONTROL",
            "paused": True, "state": "DISABLED", "config_hash": config_hash(app), "updated_at": now}),
            ConditionExpression="attribute_not_exists(app) OR (#s IN (:disabled,:wait,:private) AND (attribute_not_exists(lease_until) OR lease_until < :now))",
            ExpressionAttributeNames={"#s": "state"},
            ExpressionAttributeValues=item({":disabled": "DISABLED", ":wait": "WAIT_SIGNALS", ":private": "WAIT_PRIVATE_SOURCE", ":now": now}))

    def report_config_change(self, app):
        """La configuration déclarée n'est plus celle qui a été configurée, vérifiée et activée : prévenir, une fois par version."""
        now = int(self.clock())
        digest = config_hash(app)
        try:
            self.client.put_item(TableName=self.table, Item=item({"app": app["app"], "record": "CONFIGALERT",
                "config_hash": digest, "at": now}),
                ConditionExpression="attribute_not_exists(app) OR config_hash <> :hash", ExpressionAttributeValues=item({":hash": digest}))
        except Exception as exc:
            if conditional_failure(exc):
                return False
            raise
        self.client.put_item(TableName=self.table, Item=item({"app": app["app"], "record": f"EVENT#{now:020d}#{uuid4()}",
            "state": "CONFIG_CHANGED", "field": "state", "at": now, "delivered": False}))
        return True

    def pause(self, app, paused):
        # Aucun contrôle implicite : un profil nouveau doit être configuré et relu.
        self.client.update_item(TableName=self.table, Key=self.key(app["app"]),
            UpdateExpression="SET paused=:p, updated_at=:now",
            ConditionExpression="attribute_exists(app) AND config_hash=:hash",
            ExpressionAttributeValues=item({":p": paused, ":now": int(self.clock()), ":hash": config_hash(app)}))

    def acquire(self, app, owner):
        now = int(self.clock())
        try:
            self.client.update_item(TableName=self.table, Key=self.key(app["app"]),
                UpdateExpression="SET lease_owner=:owner, lease_until=:end",
                ConditionExpression="attribute_exists(app) AND paused=:no AND config_hash=:hash AND "
                    "(attribute_not_exists(lease_until) OR lease_until < :now)",
                ExpressionAttributeValues=item({":owner": owner, ":end": now + LEASE_SECONDS,
                    ":no": False, ":hash": config_hash(app), ":now": now}))
            return True
        except Exception as exc:
            if conditional_failure(exc):
                return False
            raise

    def checkpoint(self, app, owner):
        now = int(self.clock())
        try:
            self.client.update_item(TableName=self.table, Key=self.key(app["app"]),
                UpdateExpression="SET lease_until=:end",
                ConditionExpression="lease_owner=:owner AND lease_until >= :now AND paused=:no AND config_hash=:hash",
                ExpressionAttributeValues=item({":owner": owner, ":end": now + LEASE_SECONDS,
                    ":now": now, ":no": False, ":hash": config_hash(app)}))
        except Exception as exc:
            if conditional_failure(exc):
                raise Blocked("PAUSED_OR_LEASE_LOST") from None
            raise

    def release(self, app, owner):
        try:
            self.client.update_item(TableName=self.table, Key=self.key(app["app"]),
                UpdateExpression="REMOVE lease_owner, lease_until", ConditionExpression="lease_owner=:owner",
                ExpressionAttributeValues=item({":owner": owner}))
        except Exception as exc:
            if not conditional_failure(exc):
                raise

    def transition(self, app, owner, state, field="state"):
        require(field in {"state", "source_fence"})
        now = int(self.clock())
        old = self.control(app["app"])
        if old.get(field) == state:
            return
        # Une écriture atomique enregistre l'état ET la notification à délivrer.
        event = {"app": app["app"], "record": f"EVENT#{now:020d}#{uuid4()}",
            "state": state, "field": field, "at": now, "delivered": False}
        self.client.transact_write_items(TransactItems=[
            {"Update": {"TableName": self.table, "Key": self.key(app["app"]),
                "UpdateExpression": "SET #s=:s, updated_at=:now",
                "ConditionExpression": "lease_owner=:owner AND lease_until >= :now AND paused=:no AND config_hash=:hash",
                "ExpressionAttributeNames": {"#s": field},
                "ExpressionAttributeValues": item({":s": state, ":now": now, ":owner": owner,
                    ":no": False, ":hash": config_hash(app)})}},
            {"Put": {"TableName": self.table, "Item": item(event)}}])
        print(json.dumps({"app": app["app"], "state": state, "at": now}))

    def remember_replication(self, app, owner, observation):
        now = int(self.clock())
        # Une lecture récente du catalogue ne rend pas un vieux message récent.
        if not (observation["enabled"] and observation["tables_ready"] and observation["replayed_lsn"] and
                0 <= now - observation["last_message_at"] <= MAX_HEALTHY_MESSAGE_AGE):
            return
        self.checkpoint(app, owner)
        self.client.put_item(TableName=self.table, Item=item({"app": app["app"], "record": "REPLICATION",
            "config_hash": config_hash(app), "observed_at": now,
            "replayed_lsn": observation["replayed_lsn"], "last_message_at": observation["last_message_at"]}))

    def replication_evidence(self, app):
        known = decode(self.client.get_item(TableName=self.table, Key=self.key(app["app"], "REPLICATION"), ConsistentRead=True).get("Item", {}))
        now = int(self.clock())
        require(known.get("config_hash") == config_hash(app) and bool(known.get("replayed_lsn")) and
            0 <= now - known.get("observed_at", 0) <= MAX_OBSERVATION_AGE and
            0 <= known.get("observed_at", 0) - known.get("last_message_at", 0) <= MAX_HEALTHY_MESSAGE_AGE,
            "BLOCKED_UNKNOWN_OR_STALE_REPLICATION")
        return {key: known[key] for key in ("observed_at", "replayed_lsn", "last_message_at")}

    def event(self, app, state):
        """Notification hors bail : opérations manuelles du retour vers GCP, worker en pause."""
        now = int(self.clock())
        self.client.put_item(TableName=self.table, Item=item({"app": app, "record": f"EVENT#{now:020d}#{uuid4()}",
            "state": state, "field": "state", "at": now, "delivered": False}))
        print(json.dumps({"app": app, "state": state, "at": now}))

    def stopped_after_promotion(self, app):
        """Le retour vers GCP exige un worker arrêté sur AWS actif : en pause, sans bail, même configuration."""
        control = self.control(app["app"])
        require(control.get("state") == "AWS_ACTIVE" and control.get("paused") is True and
            control.get("config_hash") == config_hash(app) and control.get("lease_until", 0) < int(self.clock()), "BLOCKED_FAILBACK_STATE")
        return control

    def rearm(self, app):
        """Après le retour vers GCP et la reconstruction de la copie AWS : le contrôle repart de zéro, en pause, comme à la
        configuration initiale (worker-verify puis worker-resume le réactivent). Rien n'est écrit si l'état a changé."""
        now = int(self.clock())
        try:
            self.client.put_item(TableName=self.table, Item=item({"app": app["app"], "record": "CONTROL",
                "paused": True, "state": "DISABLED", "config_hash": config_hash(app), "updated_at": now}),
                ConditionExpression="#s=:active AND paused=:yes AND config_hash=:hash AND (attribute_not_exists(lease_until) OR lease_until < :now)",
                ExpressionAttributeNames={"#s": "state"},
                ExpressionAttributeValues=item({":active": "AWS_ACTIVE", ":yes": True, ":hash": config_hash(app), ":now": now}))
        except Exception as exc:
            if conditional_failure(exc):
                raise Blocked("BLOCKED_FAILBACK_STATE") from None
            raise
        self.event(app["app"], "GCP_ACTIVE")

    def notify_pending(self, app):
        cursor = None
        # Au moins une fois. Une panne après Publish peut entraîner un doublon,
        # jamais une promotion SQL supplémentaire. Chaque message a son ID.
        while True:
            args = {"TableName": self.table, "ConsistentRead": True,
                "KeyConditionExpression": "app=:app AND begins_with(#r,:prefix)",
                "ExpressionAttributeNames": {"#r": "record"},
                "ExpressionAttributeValues": item({":app": app, ":prefix": "EVENT#"})}
            if cursor:
                args["ExclusiveStartKey"] = cursor
            response = self.client.query(**args)
            for raw in response.get("Items", []):
                event = decode(raw)
                if not event["delivered"]:
                    text = notice(event["state"])
                    if text and event["state"].startswith("BLOCKED"):
                        # Même raison notifiée il y a moins d'une heure : pas de nouvel e-mail.
                        last = decode(self.client.get_item(TableName=self.table, Key=self.key(app, "NOTICE#" + event["state"]),
                            ConsistentRead=True).get("Item", {}))
                        if 0 <= event["at"] - last.get("at", -BLOCKED_NOTICE_INTERVAL) < BLOCKED_NOTICE_INTERVAL:
                            text = None
                    if text:
                        self.sns.publish(TopicArn=self.topic, Subject=ascii_subject(f"CNP failover - {app} : {text.split(' : ')[0]}"),
                            Message=f"{text}\n\nApplication : {app}\nÉtat : {event['state']}\n\n"
                                + json.dumps({key: event[key] for key in ("app", "record", "state", "at")}))
                        if event["state"].startswith("BLOCKED"):
                            self.client.put_item(TableName=self.table, Item=item({"app": app, "record": "NOTICE#" + event["state"],
                                "at": event["at"]}))
                    self.client.update_item(TableName=self.table, Key=self.key(app, event["record"]),
                        UpdateExpression="SET delivered=:yes", ExpressionAttributeValues=item({":yes": True}))
            cursor = response.get("LastEvaluatedKey")
            if not cursor:
                return


class FixedHTTPS(http.client.HTTPSConnection):
    """Le socket vise GCP ; Host/SNI restent ceux de l'app, sans résolution DNS."""
    def __init__(self, host, address):
        super().__init__(host, timeout=5, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection((self.address, 443), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def public_health(app):
    try:
        with closing(FixedHTTPS(app["hostname"], app["gcp_lb_ip"])) as conn:
            conn.request("GET", app.get("readiness_path", "/health"), headers={"Host": app["hostname"], "Connection": "close"})
            return conn.getresponse().status == 200
    except (OSError, http.client.HTTPException):
        return False


def private_reachable(app):
    """Sonde TCP distincte : une erreur de mot de passe/CA n'est pas une panne."""
    try:
        with socket.create_connection((app["source"]["host"], 5432), timeout=5):
            return True
    except OSError:
        return False


class CloudSignals:
    def __init__(self, cloudwatch, clock=time.time, probe=public_health, private_probe=private_reachable, sleep=time.sleep):
        self.cloudwatch, self.clock, self.probe, self.private_probe, self.sleep = cloudwatch, clock, probe, private_probe, sleep

    def source_available(self, app):
        return self.private_probe(app)

    def outage_confirmed(self, app):
        alarms = self.cloudwatch.describe_alarms(AlarmNames=[app["alarm_name"]]).get("MetricAlarms", [])
        require(len(alarms) == 1, "BLOCKED_ALARM")
        alarm = alarms[0]
        require(alarm.get("AlarmArn") == f"arn:aws:cloudwatch:us-east-1:{ACCOUNT}:alarm:{app['alarm_name']}", "BLOCKED_ALARM")
        require(alarm.get("Namespace") == "AWS/Route53" and alarm.get("MetricName") == "HealthCheckStatus" and
            alarm.get("Dimensions") == [{"Name": "HealthCheckId", "Value": app["health_check_id"]}], "BLOCKED_ALARM")
        # L'alarme est relue via AWS, pas acceptée depuis un événement rejouable.
        if alarm.get("StateValue") != "ALARM":
            return False
        at = alarm.get("StateTransitionedTimestamp", alarm.get("StateUpdatedTimestamp"))
        require(isinstance(at, datetime) and at.tzinfo is not None, "BLOCKED_ALARM")
        age = self.clock() - at.timestamp()
        require(age >= -5, "BLOCKED_ALARM")
        if age < MIN_OUTAGE_SECONDS:
            # Le worker lancé par l'alarme attend ici la fin du délai, puis relit l'alarme, au lieu de laisser la bascule au
            # passage suivant (une tâche par minute : jusqu'à 1 min perdue). Le délai reste bien inférieur au bail.
            self.sleep(MIN_OUTAGE_SECONDS - age)
            return self.outage_confirmed(app)
        # Une ancienne alarme ne suffit pas : mesure Route53 fraîche exigée.
        now = self.clock()
        data = self.cloudwatch.get_metric_statistics(Namespace="AWS/Route53", MetricName="HealthCheckStatus",
            Dimensions=[{"Name": "HealthCheckId", "Value": app["health_check_id"]}],
            StartTime=datetime.fromtimestamp(now - 180, timezone.utc), EndTime=datetime.fromtimestamp(now, timezone.utc),
            Period=60, Statistics=["Maximum"]).get("Datapoints", [])
        fresh = [point for point in data if isinstance(point.get("Timestamp"), datetime) and
            0 <= now - point["Timestamp"].timestamp() <= 120]
        require(bool(fresh), "BLOCKED_STALE_METRIC")
        latest = max(fresh, key=lambda point: point["Timestamp"])
        return latest.get("Maximum") == 0 and not self.probe(app)


class SQL:
    def __init__(self, secrets):
        self.secrets = secrets

    def credentials(self, spec):
        credentials = json.loads(self.secrets.get_secret_value(SecretId=spec["secret_arn"])["SecretString"])
        require(isinstance(credentials, dict) and isinstance(credentials.get("username"), str) and
            isinstance(credentials.get("password"), str) and bool(credentials["password"]), "BLOCKED_SECRET")
        require(credentials["username"] not in {"cnp_runtime", "cnp_replication"}, "BLOCKED_SECRET")
        return credentials

    def dump_schema(self, app, side):
        """Schéma de l'application lu avec pg_dump : mêmes secrets, même CA, même mode TLS que connection()."""
        import database
        spec = app[side]
        credentials = self.credentials(spec)
        with tempfile.TemporaryDirectory(prefix="cnp-ca-") as directory:
            ca = Path(directory) / "ca.pem"
            ca.write_text(spec["ca_pem"])
            return database.dump_schema({"host": spec["host"], "port": 5432, "user": credentials["username"], "password": credentials["password"],
                "dbname": postgres_contract.database_name(app["profile"]), "sslrootcert": str(ca),
                "sslmode": "verify-ca" if side == "source" else "verify-full"})

    @contextmanager
    def connection(self, app, side):
        import psycopg
        spec = app[side]
        credentials = self.credentials(spec)
        # Le fichier temporaire contient une CA publique ; les secrets restent
        # en mémoire et ne sont ni passés sur la CLI ni écrits dans les logs.
        with tempfile.TemporaryDirectory(prefix="cnp-ca-") as directory:
            ca = Path(directory) / "ca.pem"
            ca.write_text(spec["ca_pem"])
            with psycopg.connect(host=spec["host"], port=5432,
                    dbname=postgres_contract.database_name(app["profile"]),
                    user=credentials["username"], password=credentials["password"],
                    sslmode="verify-ca" if side == "source" else "verify-full", sslrootcert=str(ca),
                    autocommit=True, connect_timeout=CONNECT_TIMEOUT,
                    options="-c statement_timeout=15000 -c lock_timeout=5000 -c application_name=cnp-failover-worker") as conn:
                yield conn

    def saved_state(self, target, profile):
        row = target.execute("SELECT state,application_profile FROM public.cnp_recovery WHERE singleton").fetchone()
        if row:
            require(row[1] == profile and row[0] in {"PROMOTING", "AWS_ACTIVE"}, "BLOCKED_SQL_STATE")
        return row[0] if row else None

    def standby_ready(self, target, app):
        import database
        from psycopg.conninfo import conninfo_to_dict
        login = target.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (database.RUNTIME,)).fetchone()
        require(login is not None and not login[0], "BLOCKED_TARGET_OPEN")
        state = database.progress(target, app["profile"])
        require(state["enabled"] and state["tables_ready"], "BLOCKED_REPLICATION")
        subscription = target.execute("SELECT subconninfo,subpublications,subslotname FROM pg_subscription WHERE subname=%s",
            (database.SUBSCRIPTION,)).fetchone()
        require(subscription is not None, "BLOCKED_REPLICATION")
        info = conninfo_to_dict(subscription[0])
        require(info.get("host") == app["source"]["host"] and info.get("port", "5432") == "5432" and
            info.get("dbname") == (postgres_contract.database_name(app["profile"])) and
            info.get("user") == "cnp_replication" and info.get("sslmode") in {"require", "verify-ca", "verify-full"} and
            subscription[1] == [database.PUBLICATION] and subscription[2] == database.SUBSCRIPTION, "BLOCKED_REPLICATION_CONFIG")

    def observation(self, target, profile):
        import database
        return database.subscriber_observation(target, profile)

    def promote_outage(self, target, app, evidence, checkpoint, on_stage):
        import database
        return database.promote_unreachable(target, evidence, profile=app["profile"], checkpoint=checkpoint, on_stage=on_stage)

    def fence_returned_source(self, source):
        import database
        database.close_source_runtime(source)

    def promote(self, source, target, app, checkpoint, on_stage):
        import database
        return database.promote_after_fence(source, target, profile=app["profile"], checkpoint=checkpoint, on_stage=on_stage)


class RoutingGate:
    """Verrou du retour DNS seulement ; ne contrôle aucune écriture applicative."""
    def __init__(self, route53):
        self.route53 = route53

    def set_closed(self, app, closed):
        parent = self.route53.get_health_check(HealthCheckId=app["primary_health_check_id"])["HealthCheck"]["HealthCheckConfig"]
        require(parent.get("Type") == "CALCULATED" and parent.get("HealthThreshold") == 2 and
            set(parent.get("ChildHealthChecks", [])) == {app["health_check_id"], app["routing_latch_id"]} and
            not parent.get("Inverted", False) and not parent.get("Disabled", False), "BLOCKED_ROUTING_CONFIG")
        health = self.route53.get_health_check(HealthCheckId=app["routing_latch_id"])["HealthCheck"]
        config = health["HealthCheckConfig"]
        require(config.get("Type") == "HTTPS" and config.get("Disabled") is True and
            config.get("IPAddress") == app["gcp_lb_ip"] and config.get("FullyQualifiedDomainName") == app["hostname"] and
            config.get("Port") == 443 and config.get("ResourcePath") == app.get("readiness_path", "/health") and config.get("EnableSNI") is True,
            "BLOCKED_ROUTING_CONFIG")
        # Une sonde HTTP désactivée est healthy ; l'inversion ferme le verrou.
        # Un parent CALCULATED ne peut pas référencer un enfant CALCULATED.
        inverted = closed
        if config.get("Inverted", False) != inverted:
            self.route53.update_health_check(HealthCheckId=app["routing_latch_id"],
                HealthCheckVersion=health["HealthCheckVersion"], Inverted=inverted)
        # Relecture explicite après écriture ; aucune réouverture après promotion.
        actual = self.route53.get_health_check(HealthCheckId=app["routing_latch_id"])["HealthCheck"]["HealthCheckConfig"]
        require(actual.get("Inverted", False) == inverted, "BLOCKED_ROUTING_CONFIG")


class Worker:
    def __init__(self, store, signals, sql, routing):
        self.store, self.signals, self.sql, self.routing = store, signals, sql, routing

    def fence_on_return(self, app, checkpoint, owner):
        status = "GCP_FENCE_PENDING"
        if self.signals.source_available(app):
            try:
                checkpoint()
                with self.sql.connection(app, "source") as source:
                    self.sql.fence_returned_source(source)
                status = "GCP_FENCED"
            except Blocked as exc:
                if str(exc) == "PAUSED_OR_LEASE_LOST":
                    raise
                status = "GCP_FENCE_RETRY"
            except Exception:
                status = "GCP_FENCE_RETRY"
        self.store.transition(app, owner, status, field="source_fence")

    def run(self, app):
        owner = str(uuid4())
        known = self.store.control(app["app"]).get("config_hash")
        if known is not None and known != config_hash(app):
            # Configurée puis modifiée sans nouvelle vérification : aucune action, et le manager est prévenu.
            self.store.report_config_change(app)
            print(json.dumps({"app": app["app"], "state": "BLOCKED_CONFIG_CHANGED"}))      # la raison doit figurer dans les journaux
            return "BLOCKED_CONFIG_CHANGED"
        if not self.store.acquire(app, owner):
            return "PAUSED_UNCONFIGURED_OR_BUSY"
        checkpoint = lambda: self.store.checkpoint(app, owner)
        state = "BLOCKED_OPERATION"
        sql_active = False
        try:
            checkpoint()
            with ExitStack() as stack:
                target = stack.enter_context(self.sql.connection(app, "target"))
                saved = self.sql.saved_state(target, app["profile"])
                require(self.store.control(app["app"]).get("state") != "AWS_ACTIVE" or saved == "AWS_ACTIVE", "BLOCKED_SQL_STATE")
                if saved == "AWS_ACTIVE":
                    sql_active = True
                    # Reprise après commit SQL réussi mais écriture DynamoDB échouée.
                    checkpoint()
                    self.routing.set_closed(app, True)
                    state = "AWS_ACTIVE"
                else:
                    if saved != "PROMOTING":
                        self.sql.standby_ready(target, app)
                        observation = self.sql.observation(target, app["profile"])
                        self.store.remember_replication(app, owner, observation)
                        if not self.signals.outage_confirmed(app):
                            # Annulation avant toute décision SQL : un échec du
                            # verrou DNS seul ne doit pas laisser GCP masqué.
                            checkpoint()
                            self.routing.set_closed(app, False)
                            raise Blocked("WAIT_SIGNALS")
                        require(not self.signals.source_available(app), "WAIT_PRIVATE_SOURCE")
                        evidence = self.store.replication_evidence(app)
                        require(self.signals.outage_confirmed(app) and not self.signals.source_available(app), "WAIT_SIGNALS")
                        evidence.update(source_unreachable=True, public_unreachable=True)
                    else:
                        # La décision durable est déjà prise ; la source revenue
                        # doit être clôturée avant de terminer cette reprise.
                        self.fence_on_return(app, checkpoint, owner)
                        fence = self.store.control(app["app"]).get("source_fence")
                        require(fence in {"GCP_FENCED", "GCP_FENCE_PENDING"}, "BLOCKED_GCP_RETURN")
                        evidence = {}
                    checkpoint()
                    self.store.transition(app, owner, "CLOSING_GCP_ROUTE")
                    self.routing.set_closed(app, True)
                    result = self.sql.promote_outage(target, app, evidence, checkpoint,
                        lambda stage: self.store.transition(app, owner, stage))
                    require(result.get("state") == "AWS_ACTIVE", "BLOCKED_SQL_STATE")
                    sql_active = True
                    state = "AWS_ACTIVE"
            self.store.transition(app, owner, state)
            self.fence_on_return(app, checkpoint, owner)
            return state
        except Blocked as exc:
            state = str(exc)
        except Exception:
            # Erreurs SQL/AWS susceptibles de contenir DSN, SQL et mots de passe.
            state = "BLOCKED_OPERATION"
        finally:
            try:
                if not sql_active and state not in {"AWS_ACTIVE", "PAUSED_OR_LEASE_LOST"}:
                    self.store.transition(app, owner, state)
            finally:
                self.store.release(app, owner)
        return state


class Failback:
    """Retour manuel vers GCP, côté worker : seul le worker tient le verrou DNS et son propre état.

    route : rouvre le verrou DNS de GCP avant la copie. Sans risque pour les données : GCP reste fermé (NOLOGIN) jusqu'à la
    copie vérifiée, sa sonde /health échoue donc et Route 53 garde AWS ; la bascule du trafic suit d'elle-même la réouverture
    de GCP (environ 30 s de sonde), au lieu d'attendre une tâche de plus pendant que les écritures sont refusées.
    rearm : la copie AWS a été reconstruite depuis GCP (aucune reprise inscrite, abonnement prêt) : le contrôle est réinitialisé.
    """
    def __init__(self, store, sql, routing):
        self.store, self.sql, self.routing = store, sql, routing

    def route(self, app):
        control = self.store.stopped_after_promotion(app)
        # Le worker a joint GCP et l'a clôturé : la source est revenue, et fermée.
        require(control.get("source_fence") == "GCP_FENCED", "BLOCKED_GCP_NOT_FENCED")
        self.routing.set_closed(app, False)
        self.store.event(app["app"], "GCP_ROUTE_REOPENED")
        return "GCP_ROUTE_REOPENED"

    def rearm(self, app):
        self.store.stopped_after_promotion(app)
        with self.sql.connection(app, "target") as target:
            require(self.sql.saved_state(target, app["profile"]) is None, "BLOCKED_SQL_STATE")
            self.sql.standby_ready(target, app)
        self.store.rearm(app)
        return "DISABLED"


def platform_mode():
    return bool(os.environ.get("CNP_CONFIG_TABLE"))


def aws_session():
    import boto3
    from botocore.config import Config
    settings = Config(connect_timeout=3, read_timeout=5, retries={"mode": "standard", "total_max_attempts": 2})
    session = boto3.Session(region_name=REGION)
    require(session.client("sts", config=settings).get_caller_identity()["Account"] == ACCOUNT, "WRONG_AWS_ACCOUNT")
    return lambda service, region=REGION: session.client(service, region_name=region, config=settings)


def platform_config(client):
    require(os.environ.get("CNP_CONFIG_TABLE") == PLATFORM["config_table"], "INVALID_CONFIG_TABLE")
    return ConfigTable(client("dynamodb"), PLATFORM["config_table"])


def require_names():
    """Les noms viennent de l'environnement : ils sont contrôlés hors ligne, avant toute session AWS."""
    names = PLATFORM
    require(os.environ.get("CNP_CONFIG_TABLE") == PLATFORM["config_table"], "INVALID_CONFIG_TABLE")
    table, topic = os.environ.get("CNP_STATE_TABLE", ""), os.environ.get("CNP_NOTIFICATION_TOPIC", "")
    require(table == names["state_table"], "INVALID_STATE_TABLE")
    require(topic == f"arn:aws:sns:{REGION}:{ACCOUNT}:{names['topic']}", "INVALID_TOPIC")
    return table, topic


def aws_components(client=None):
    table, topic = require_names()
    client = client or aws_session()
    return (Store(client("dynamodb"), table, topic, client("sns")),
        CloudSignals(client("cloudwatch", "us-east-1")), SQL(client("secretsmanager")), RoutingGate(client("route53")))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["run", "configure", "pause", "resume", "status", "failback-route", "rearm"])
    parser.add_argument("--app")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        client, failed = None, False
        if platform_mode():
            require(args.operation in {"run", "status"} or bool(args.app), "EXPLICIT_APP_REQUIRED")
            if not args.execute:
                print(json.dumps({"simulation": True, "operation": args.operation, "applications": [args.app] if args.app else "table de configuration",
                    "cloud_called": False, "sql_executed": False}))
                return 0
            require_names()
            client = aws_session()
            apps, invalid = platform_config(client).applications()
            for name in invalid:
                print(json.dumps({"app": name, "state": "BLOCKED_INVALID_CONFIG"}))
            failed = bool(invalid)
            if args.app:
                apps = [app for app in apps if app["app"] == args.app]
                require(bool(apps), "UNKNOWN_APP")
        else:
            # Le régime historique du pilote (configuration dans la définition de tâche) a été retiré le 07/11/2026.
            raise Blocked("PLATFORM_CONFIG_TABLE_REQUIRED")
        store, signals, sql, routing = aws_components(client)
        for app in apps:
            try:
                if args.operation == "run":
                    state = Worker(store, signals, sql, routing).run(app)
                    failed |= state.startswith("BLOCKED")
                elif args.operation == "configure":
                    store.configure(app)
                elif args.operation in {"failback-route", "rearm"}:
                    failback = Failback(store, sql, routing)
                    print(json.dumps({"app": app["app"], "operation": args.operation,
                        "state": failback.route(app) if args.operation == "failback-route" else failback.rearm(app)}))
                elif args.operation in {"pause", "resume"}:
                    store.pause(app, args.operation == "pause")
                else:
                    print(json.dumps(store.control(app["app"])))
                # La file de notifications est aussi drainée lorsque le worker
                # est en pause ou AWS déjà actif, sans toucher aux bases.
                store.notify_pending(app["app"])
            except Blocked as exc:
                # Code public constant (jamais de détail fournisseur) : le portail l'affiche au manager.
                print(json.dumps({"app": app["app"], "state": str(exc)}))
                failed = True
            except Exception:
                print(json.dumps({"app": app["app"], "state": "BLOCKED_OPERATION"}))
                failed = True
        return int(failed)
    except Exception:
        print("Configuration ou opération refusée ; aucun détail sensible affiché.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
