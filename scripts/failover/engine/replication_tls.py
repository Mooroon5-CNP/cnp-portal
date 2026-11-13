import postgres_contract
"""Politique explicite du subscriber natif ; aucun repli automatique de TLS."""
import ipaddress
from pathlib import PurePosixPath

from psycopg.conninfo import conninfo_to_dict, make_conninfo


def validate_dsn(dsn, profile, acknowledge_wireguard_subscriber_trust=False):
    info = conninfo_to_dict(dsn)
    allowed = {"host", "port", "dbname", "user", "password", "sslmode", "sslrootcert", "connect_timeout", "application_name"}
    expected = postgres_contract.database_name(profile)
    if set(info) - allowed or info.get("user") != "cnp_replication" or info.get("dbname") != expected or \
            not info.get("host") or not info.get("password") or info.get("port", "5432") != "5432":
        raise ValueError("Chaîne de réplication non conforme au profil.")
    mode = info.get("sslmode")
    if mode in {"verify-ca", "verify-full"}:
        path = info.get("sslrootcert", "")
        if not path.startswith("/") or ".." in PurePosixPath(path).parts:
            raise ValueError("Chemin de CA réellement accessible sur RDS requis.")
    elif mode == "require":
        if acknowledge_wireguard_subscriber_trust is not True or \
                ipaddress.IPv4Address(info["host"]) not in ipaddress.ip_network("10.189.0.0/16") or info.get("sslrootcert"):
            raise ValueError("TLS sur tunnel privé exige un choix de confiance explicite.")
    else:
        raise ValueError("Réplication sans TLS obligatoire interdite.")
    # Reconnexion de l'abonnement après une coupure : même négociation lente que les autres connexions (voir automation.CONNECT_TIMEOUT).
    return make_conninfo(**{**info, "connect_timeout": "20"})
