"""Opérations de recette PostgreSQL ; aucune connexion ni mutation à l'import.

Le schéma de l'application est lu dans sa base (introspection) ; les contrats écrits à la main du pilote (recipe, pixelcalm)
et la forme déclarative ont été retirés le 07/11/2026.
"""
import hashlib
import json
import os
import re
import subprocess
import time
from datetime import datetime, timezone
from uuid import uuid4
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
import replication_tls
import postgres_contract

PUBLICATION = "cnp_recipe_publication"
SUBSCRIPTION = "cnp_recipe_subscription"
RUNTIME = "cnp_runtime"

# Tables propres à CNP : jamais répliquées comme données applicatives, jamais décrites ni restaurées depuis la source.
TECHNICAL_TABLES = ('replication_barrier', 'cnp_recovery')
# pg_dump ne lit que le schéma de l'application. Propriétaires, droits, publications et abonnements sont posés par CNP.
DUMP_FLAGS = ['--schema-only', '--no-owner', '--no-privileges', '--no-publications', '--no-subscriptions', '--no-comments',
    '--schema=public', '--exclude-table=public.replication_barrier', '--exclude-table=public.cnp_recovery']
MAX_REPORTED = 8


def introspected(profile):
    return postgres_contract.is_introspected(profile)


def _connection_required(conn):
    if conn is None:
        raise ValueError("Connexion requise : les tables d'un profil introspecté se lisent dans la base, elles ne se devinent pas.")


def tables(profile, conn=None):
    _connection_required(conn)
    return discover(conn)['tables']


def sequences(profile, conn=None):
    _connection_required(conn)
    return discover(conn)['sequences']


def published_tables(profile, conn=None):
    return {('public', name) for name in [*tables(profile, conn), 'replication_barrier']}


def align_sequences(conn, profile):
    for table in sorted(tables(profile, conn)):
        conn.execute(sql.SQL('LOCK TABLE public.{} IN ACCESS EXCLUSIVE MODE').format(sql.Identifier(table)))
    for table, column, sequence in sequences(profile, conn):
        # PostgreSQL ne réplique pas les séquences ; conserver aussi leur état
        # local évite de réutiliser un identifiant après reprise interrompue.
        increment = conn.execute('SELECT increment_by,min_value,cycle FROM pg_sequences WHERE schemaname=%s AND sequencename=%s', ('public', sequence)).fetchone()
        if increment is None or increment[0] != 1 or increment[1] != 1 or increment[2]:
            raise ValueError('Séquence différente du contrat positif non cyclique.')
        conn.execute(sql.SQL('SELECT setval(%s,GREATEST(COALESCE((SELECT max({}) FROM public.{}),0),(SELECT last_value FROM public.{}),1),true)').format(
            sql.Identifier(column), sql.Identifier(table), sql.Identifier(sequence)), ('public.' + sequence,))


def guard_bootstrap(conn, source=False):
    """Une nouvelle initialisation ne doit jamais annuler une clôture/bascule."""
    if conn.execute("SELECT to_regclass('public.cnp_recovery')").fetchone()[0]:
        if conn.execute("SELECT 1 FROM public.cnp_recovery WHERE singleton").fetchone():
            raise ValueError("Reprise déjà engagée : initialisation interdite.")
    if conn.execute("SELECT 1 FROM pg_subscription WHERE subname=%s", (SUBSCRIPTION,)).fetchone():
        raise ValueError("Abonnement existant : ne pas réinitialiser la base.")
    if source and conn.execute("SELECT 1 FROM pg_publication WHERE pubname=%s", (PUBLICATION,)).fetchone():
        role = conn.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
        if role is None or not role[0]:
            raise ValueError("Source déjà clôturée : aucune réouverture par le bootstrap.")


def create_target_runtime(conn, password):
    """Initialisation uniquement ; aucun changement implicite d'un mot de passe existant."""
    if not isinstance(password, str) or not 24 <= len(password) <= 1024 or '\x00' in password:
        raise ValueError("Secret runtime absent ou non conforme.")
    guard_bootstrap(conn)
    if conn.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone():
        raise ValueError("Rôle existant : utiliser prepare-target ; aucune rotation implicite.")
    conn.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD {}").format(
        sql.Identifier(RUNTIME), sql.Literal(password)))


def native_tls_probe(conn, replication_dsn, profile=None, acknowledge_wireguard_subscriber_trust=False):
    """Connexion libpq exécutée PAR le serveur cible, sans slot ni copie de données.

    Le contrôle n'importe aucun certificat dans RDS. Il vérifie le mode choisi
    depuis le serveur cible ; seul server-ca est annoncé comme CA vérifiée.
    """
    replication_dsn = replication_tls.validate_dsn(replication_dsn, profile, acknowledge_wireguard_subscriber_trust)
    certificate_verified = conninfo_to_dict(replication_dsn)["sslmode"] in {"verify-ca", "verify-full"}
    name = "cnp_tls_probe_" + uuid4().hex
    created = False
    try:
        conn.execute(sql.SQL("CREATE SUBSCRIPTION {} CONNECTION {} PUBLICATION {} WITH "
            "(connect=true, enabled=false, create_slot=false, copy_data=false, slot_name=NONE)").format(
                sql.Identifier(name), sql.Literal(replication_dsn), sql.Identifier(PUBLICATION)))
        created = True
        row = conn.execute("SELECT oid,subenabled,subslotname FROM pg_subscription WHERE subname=%s", (name,)).fetchone()
        if row is None or row[1] or row[2] is not None:
            raise ValueError("Contrôle natif différent du contrat sans slot.")
        tables = conn.execute("SELECT n.nspname,c.relname FROM pg_subscription_rel r "
            "JOIN pg_class c ON c.oid=r.srrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.srsubid=%s", (row[0],)).fetchall()
        if set(tables) != published_tables(profile, conn):
            raise ValueError("Publication source absente ou différente du profil attendu.")
        return {"native_tls_verified": certificate_verified, "native_tls_connected": True,
            "subscriber_trust": "server-ca" if certificate_verified else "wireguard-tls",
            "copy_started": False, "slot_created": False}
    finally:
        if created:
            conn.execute(sql.SQL("DROP SUBSCRIPTION {}").format(sql.Identifier(name)))


def replication_status(source, target, profile=None):
    """Observations seulement : le volume de WAL n'est pas une mesure de perte métier."""
    state = progress(target, profile)
    slot = source.execute("SELECT active,pg_wal_lsn_diff(pg_current_wal_lsn(),restart_lsn),"
        "pg_wal_lsn_diff(pg_current_wal_lsn(),confirmed_flush_lsn) FROM pg_replication_slots "
        "WHERE slot_name=%s AND plugin='pgoutput' AND database=current_database()", (SUBSCRIPTION,)).fetchone()
    workers = target.execute("SELECT pid IS NOT NULL,last_msg_receipt_time,latest_end_time "
        "FROM pg_stat_subscription WHERE subname=%s AND relid IS NULL", (SUBSCRIPTION,)).fetchall()
    now = datetime.now(timezone.utc)
    receipt = next((row[1] for row in workers if row[0] and row[1]), None)
    drift = {}
    if introspected(profile):
        # Une migration appliquée d'un seul côté ne se voit pas dans la réplication : elle se voit dans l'empreinte.
        wanted = schema_fingerprint(source)
        drift = {"schema_in_sync": wanted == schema_fingerprint(target), "schema_fingerprint": wanted}
    return {**state, **drift, "observed_at": now.isoformat(), "slot_exists": slot is not None,
        "slot_active": bool(slot and slot[0]), "retained_wal_bytes": int(slot[1]) if slot and slot[1] is not None else None,
        "unacknowledged_wal_bytes": int(slot[2]) if slot and slot[2] is not None else None,
        "last_message_age_seconds": max(0, (now-receipt).total_seconds()) if receipt else None,
        "business_rpo_measured": False}


def discover(conn):
    """Objets applicatifs de CETTE base, lus dans son catalogue : rien n'est saisi à la main.

    Les tables techniques de CNP et les objets d'extensions sont ignorés. Ce que la réplication logique native ne copie
    pas fidèlement est listé dans « unsupported » plutôt que copié à moitié.
    """
    technical = list(TECHNICAL_TABLES)
    not_extension = "NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')"
    rows = conn.execute("SELECT c.relname,c.relkind,c.relispartition,c.relreplident,"
        "EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisprimary) "
        "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname='public' AND c.relkind IN ('r','p','m') AND c.relname<>ALL(%s) AND " + not_extension + " ORDER BY 1",
        (technical,)).fetchall()
    found, unsupported, needs_full = [], [], []
    for name, kind, partition, identity, has_key in rows:
        if kind == 'm':
            unsupported.append(f'vue matérialisée {name} (ses données ne se répliquent pas)')
        elif kind == 'p' or partition:
            unsupported.append(f'table partitionnée {name}')
        else:
            found.append(name)
            if not has_key and identity in ('d', 'n'):
                needs_full.append(name)
    for row in conn.execute("SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE c.relkind IN ('r','p','m') AND n.nspname NOT IN ('public','information_schema') AND n.nspname !~ '^pg_' "
            "AND " + not_extension + " ORDER BY 1").fetchall():
        unsupported.append(f'table hors du schéma public : {row[0]}')
    owned = []
    for table, column, sequence, step, minimum, cycle in conn.execute(
            "SELECT t.relname,a.attname,s.relname,q.increment_by,q.min_value,q.cycle "
            "FROM pg_class s JOIN pg_namespace n ON n.oid=s.relnamespace AND n.nspname='public' "
            "JOIN pg_sequences q ON q.schemaname='public' AND q.sequencename=s.relname "
            "LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=s.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i') "
            "LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid "
            "WHERE s.relkind='S' ORDER BY 3").fetchall():
        if table is None:
            unsupported.append(f'séquence non rattachée à une colonne : {sequence}')
        elif table in technical:
            continue
        elif step != 1 or minimum != 1 or cycle:
            unsupported.append(f'séquence {sequence} hors du cas pris en charge (pas 1, minimum 1, sans cycle)')
        else:
            owned.append((table, column, sequence))
    extensions = [row[0] for row in conn.execute("SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY 1").fetchall()]
    return {'tables': found, 'sequences': owned, 'unsupported': unsupported, 'needs_full_identity': needs_full, 'extensions': extensions}


def require_supported(conn):
    found = discover(conn)
    if found['unsupported']:
        shown = found['unsupported'][:MAX_REPORTED]
        more = len(found['unsupported']) - len(shown)
        raise ValueError('Schéma non pris en charge par la réplication logique native : ' + '; '.join(shown) + (f' (+{more} autres)' if more else '') + '.')
    if not found['tables']:
        raise ValueError("Aucune table applicative dans le schéma public : démarrer l'application ou appliquer ses migrations sur la source avant de répliquer.")
    return found


def inspect_source(conn):
    """Lecture seule : le schéma de l'application est-il prêt à être répliqué ?

    Un schéma encore vide n'est pas une erreur : l'application peut ne l'avoir pas encore créé (au premier appel, par
    exemple). Un schéma non pris en charge est rapporté pour que le manager le corrige, jamais copié à moitié.
    """
    found = discover(conn)
    return {'schema_ready': bool(found['tables']) and not found['unsupported'], 'tables': len(found['tables']),
        'unsupported': found['unsupported'][:MAX_REPORTED], 'replica_identity_full_needed': found['needs_full_identity'],
        'extensions': found['extensions']}


def prepare_source_schema(conn):
    """Vérifie le schéma de l'application, puis rend ses tables sans clé primaire réplicables (UPDATE/DELETE).

    Rien n'est modifié tant que tout le schéma n'est pas jugé pris en charge.
    """
    found = require_supported(conn)
    for name in found['needs_full_identity']:
        conn.execute(sql.SQL('ALTER TABLE public.{} REPLICA IDENTITY FULL').format(sql.Identifier(name)))
    return {'tables': len(found['tables']), 'replica_identity_full': found['needs_full_identity'], 'extensions': found['extensions']}


def schema_fingerprint(conn):
    """Empreinte du schéma applicatif : égale des deux côtés tant qu'aucune migration n'a divergé.

    Les colonnes sont numérotées dans l'ordre sans trous (une colonne supprimée puis un état identique restent égaux), et le
    search_path est fixé : sans cela, pg_get_*def qualifie ou non les noms selon l'état de la session.
    """
    technical = list(TECHNICAL_TABLES)
    queries = {
        'columns': ("SELECT c.relname,row_number() OVER (PARTITION BY c.oid ORDER BY a.attnum),a.attname,format_type(a.atttypid,a.atttypmod),"
            "a.attnotnull,a.attidentity::text,a.attgenerated::text,pg_get_expr(d.adbin,d.adrelid) "
            "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped "
            "LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname<>ALL(%s) ORDER BY 1,2"),
        'constraints': ("SELECT t.relname,k.conname,k.contype::text,pg_get_constraintdef(k.oid) FROM pg_constraint k "
            "JOIN pg_class t ON t.oid=k.conrelid WHERE k.connamespace='public'::regnamespace AND t.relname<>ALL(%s) ORDER BY 1,2"),
        'indexes': "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename<>ALL(%s) ORDER BY 1,2",
        'replica_identity': ("SELECT c.relname,c.relreplident::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
            "WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname<>ALL(%s) ORDER BY 1"),
    }
    plain = {
        'sequences': ("SELECT sequencename,data_type::text,start_value,min_value,max_value,increment_by,cycle FROM pg_sequences "
            "WHERE schemaname='public' ORDER BY 1"),
        'enums': ("SELECT t.typname,e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace "
            "WHERE n.nspname='public' ORDER BY t.typname,e.enumsortorder"),
        'extensions': "SELECT extname FROM pg_extension WHERE extname<>'plpgsql' ORDER BY 1",
    }
    with conn.transaction():
        conn.execute('SET LOCAL search_path TO public')
        parts = {name: [list(row) for row in conn.execute(query, (technical,)).fetchall()] for name, query in queries.items()}
        parts.update({name: [list(row) for row in conn.execute(query).fetchall()] for name, query in plain.items()})
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()


def dump_schema(params, run=None, environ=None):
    """Lit le schéma de la source avec pg_dump. Aucun secret en argument ; environnement réduit au strict nécessaire.

    Le client doit être au moins de la version du serveur ; CNP_PG_DUMP permet d'imposer le binaire adapté.
    """
    environ = os.environ if environ is None else environ
    env = {key: environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR') if key in environ}
    env.update(PGHOST=str(params['host']), PGPORT=str(params.get('port', 5432)), PGUSER=params['user'], PGPASSWORD=params['password'],
        PGDATABASE=params['dbname'], PGSSLMODE=params.get('sslmode', 'verify-full'), PGCONNECT_TIMEOUT='10', PGAPPNAME='cnp-failover-schema')
    if params.get('sslrootcert'):
        env['PGSSLROOTCERT'] = params['sslrootcert']
    argv = [environ.get('CNP_PG_DUMP', 'pg_dump'), *DUMP_FLAGS]
    run = run or (lambda argv, env: subprocess.run(argv, env=env, capture_output=True, text=True, timeout=300))
    result = run(argv, env)
    if result.returncode != 0 or not result.stdout:
        # La sortie d'erreur peut contenir l'hôte ou l'utilisateur : on ne la relaie pas.
        raise ValueError('Lecture du schéma de la source impossible : vérifier que le client pg_dump est au moins de la version du serveur, les droits et la connexion TLS.')
    return result.stdout


def executable_dump(text, known_settings=None):
    """Adapte le script pg_dump pour psycopg et pour la version du serveur cible.

    - retire les commandes psql qu'il ajoute (\\restrict / \\unrestrict, versions récentes) : psycopg exécute du SQL pur ;
    - rend idempotente la création du schéma public ;
    - si known_settings est fourni, retire les « SET paramètre = … » dont le paramètre n'existe pas sur la cible : un client
      plus récent que le serveur en ajoute (transaction_timeout depuis la 17), un PostgreSQL plus ancien les refuse.

    Toute autre ligne est laissée intacte : une commande inattendue produira une erreur, jamais une exécution silencieuse.
    """
    lines = [line for line in text.splitlines() if not re.fullmatch(r'\\(un)?restrict [A-Za-z0-9]+', line)]
    if known_settings is not None:
        lines = [line for line in lines
                 if not (m := re.fullmatch(r'SET ([a-z_][a-z0-9_.]*) = .*;', line)) or m.group(1) in known_settings]
    # Le schéma public existe déjà sur toute base PostgreSQL ; le script le recréerait sans cette précaution.
    return '\n'.join('CREATE SCHEMA IF NOT EXISTS public;' if line == 'CREATE SCHEMA public;' else line for line in lines) + '\n'


def copy_schema(source, target, dump):
    """Restaure sur la cible le schéma lu sur la source. Ne migre jamais une cible déjà différente."""
    wanted = require_supported(source)
    expected = schema_fingerprint(source)
    present = discover(target)
    if present['tables'] or present['unsupported']:
        if schema_fingerprint(target) == expected:
            return {'tables': len(wanted['tables']), 'schema_fingerprint': expected, 'already_restored': True}
        raise ValueError('Cible non vide et différente de la source : aucune migration automatique.')
    available = {row[0] for row in target.execute('SELECT name FROM pg_available_extensions').fetchall()}
    missing = [name for name in wanted['extensions'] if name not in available]
    if missing:
        raise ValueError('Extensions de la source indisponibles sur la cible : ' + ', '.join(missing) + '.')
    for name in wanted['extensions']:
        target.execute(sql.SQL('CREATE EXTENSION IF NOT EXISTS {}').format(sql.Identifier(name)))
    try:
        # Plusieurs instructions sans paramètre : une seule requête, donc tout ou rien.
        target.execute(executable_dump(dump(), {row[0] for row in target.execute('SELECT name FROM pg_settings').fetchall()}))
    finally:
        # Le script règle search_path, statement_timeout…: ne pas laisser ces réglages à la suite de la session.
        target.execute('RESET ALL')
    actual = schema_fingerprint(target)
    if actual != expected:
        raise ValueError('Le schéma restauré diffère de la source : ne pas poursuivre.')
    return {'tables': len(wanted['tables']), 'schema_fingerprint': actual, 'already_restored': False}


def adopt_runtime_tables(conn):
    """Rend l'administrateur membre de cnp_runtime quand ce rôle possède des objets de l'application.

    Une application crée ses tables en tant que cnp_runtime, qui en est donc propriétaire. Sur Cloud SQL, l'administrateur
    n'est pas superutilisateur : sans cette appartenance, il ne peut ni donner les droits, ni fixer l'identité de réplication,
    ni publier ces tables (« permission denied for table … », constaté en G5 le 6/11/2026). Il a CREATEROLE, donc le droit
    de se donner ce rôle ; il n'y gagne rien de plus que ce qu'il administre déjà. Sans effet pour un superutilisateur.
    """
    owned = conn.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m') AND c.relowner=%s::regrole", (RUNTIME,)).fetchone()[0]
    if owned and not conn.execute("SELECT pg_has_role(current_user, %s, 'USAGE')", (RUNTIME,)).fetchone()[0]:
        conn.execute(sql.SQL("GRANT {} TO CURRENT_USER").format(sql.Identifier(RUNTIME)))
    return {'runtime_objects': owned}


def restrict_cloudsql_runtime(conn):
    # Cloud SQL crée les BUILT_IN dans cloudsqlsuperuser par défaut. Le rôle
    # de recette ne doit jamais conserver ces privilèges d'administration.
    if conn.execute("SELECT 1 FROM pg_roles WHERE rolname='cloudsqlsuperuser'").fetchone():
        conn.execute("REVOKE cloudsqlsuperuser FROM cnp_runtime")
    conn.execute("ALTER ROLE cnp_runtime NOCREATEDB NOCREATEROLE")


def install_technical(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS public.replication_barrier (id uuid PRIMARY KEY)")
    # État local de la procédure, absent de la publication ; aucune donnée app.
    conn.execute("CREATE TABLE IF NOT EXISTS public.cnp_recovery (singleton boolean PRIMARY KEY DEFAULT true "
        "CHECK(singleton), state text NOT NULL, barrier uuid NOT NULL, application_profile text NOT NULL, "
        "promotion_mode text NOT NULL DEFAULT 'FENCED', evidence jsonb NOT NULL DEFAULT '{}'::jsonb)")


def install_schema(conn, profile=None):
    # Le schéma est celui de l'application (source) ou sa copie restaurée (cible) : CNP n'y crée que ses tables.
    install_technical(conn)


def configure_runtime(conn, standby, profile=None):
    row = conn.execute("SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
    if row is None:
        raise ValueError("Le rôle applicatif et son secret doivent être provisionnés auparavant.")
    if any(row) or conn.execute("SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member "
            "WHERE r.rolname=%s", (RUNTIME,)).fetchone():
        raise ValueError("Rôle runtime trop privilégié : ne pas le réutiliser.")
    conn.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(sql.Identifier(RUNTIME)))
    for name in tables(profile, conn):
        conn.execute(sql.SQL('GRANT {} ON public.{} TO {}').format(sql.SQL('SELECT,INSERT,UPDATE,DELETE'), sql.Identifier(name), sql.Identifier(RUNTIME)))
    for _, _, name in sequences(profile, conn):
        conn.execute(sql.SQL('GRANT USAGE,SELECT ON SEQUENCE public.{} TO {}').format(sql.Identifier(name), sql.Identifier(RUNTIME)))
    conn.execute(sql.SQL("ALTER ROLE {} {}").format(sql.Identifier(RUNTIME), sql.SQL("NOLOGIN" if standby else "LOGIN")))


def publisher(conn, profile=None):
    if conn.execute("SHOW wal_level").fetchone()[0] != "logical":
        raise ValueError("Le décodage logique doit être activé avant la réplication.")
    relation_names = sql.SQL(', ').join(sql.Identifier('public', name) for _, name in sorted(published_tables(profile, conn)))
    if not conn.execute("SELECT 1 FROM pg_publication WHERE pubname=%s", (PUBLICATION,)).fetchone():
        conn.execute(sql.SQL('CREATE PUBLICATION {} FOR TABLE {}').format(sql.Identifier(PUBLICATION), relation_names))
    else:
        # Schéma lu dans la base : après une migration de l'application, la publication suit ses tables (une table ajoutée
        # doit être répliquée).
        current = set(conn.execute('SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname=%s', (PUBLICATION,)).fetchall())
        if current != published_tables(profile, conn):
            conn.execute(sql.SQL('ALTER PUBLICATION {} SET TABLE {}').format(sql.Identifier(PUBLICATION), relation_names))
    actual = conn.execute('SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname=%s', (PUBLICATION,)).fetchall()
    if set(actual) != published_tables(profile, conn):
        raise ValueError('Publication existante différente du contrat.')
    # Idempotent : un rôle déjà répliquant n'est pas réécrit (sur un PostgreSQL standard, seul un superutilisateur peut le faire).
    if conn.execute("SELECT rolreplication AND rolcanlogin FROM pg_roles WHERE rolname='cnp_replication'").fetchone() != (True,):
        conn.execute('ALTER ROLE cnp_replication WITH REPLICATION LOGIN')
    conn.execute('GRANT USAGE ON SCHEMA public TO cnp_replication')
    conn.execute(sql.SQL('GRANT SELECT ON {} TO cnp_replication').format(relation_names))


def subscribe(conn, replication_dsn, profile=None):
    # Appel hors transaction. Le DSN est un secret : aucune sortie SQL/erreur brute.
    if conn.execute("SELECT 1 FROM pg_subscription WHERE subname=%s", (SUBSCRIPTION,)).fetchone():
        raise ValueError("Abonnement existant : contrôler sa configuration, sans recréer la copie initiale.")
    for name in [*tables(profile, conn), "replication_barrier"]:
        if conn.execute(sql.SQL("SELECT 1 FROM public.{} LIMIT 1").format(sql.Identifier(name))).fetchone():
            raise ValueError("La cible doit être vide avant la copie initiale.")
    conn.execute(sql.SQL("CREATE SUBSCRIPTION {} CONNECTION {} PUBLICATION {} "
        "WITH (copy_data=true, create_slot=true, enabled=true)").format(
            sql.Identifier(SUBSCRIPTION), sql.Literal(replication_dsn), sql.Identifier(PUBLICATION)))


def progress(conn, profile=None):
    sub = conn.execute("SELECT oid,subenabled FROM pg_subscription WHERE subname=%s", (SUBSCRIPTION,)).fetchone()
    if sub is None:
        raise ValueError("Abonnement absent.")
    states = conn.execute("SELECT r.srsubstate,n.nspname,c.relname FROM pg_subscription_rel r "
        "JOIN pg_class c ON c.oid=r.srrelid JOIN pg_namespace n ON n.oid=c.relnamespace "
        "WHERE r.srsubid=%s", (sub[0],)).fetchall()
    origin = conn.execute("SELECT remote_lsn::text FROM pg_replication_origin_status WHERE external_id=%s", ("pg_" + str(sub[0]),)).fetchone()
    expected_tables = published_tables(profile, conn) if profile else None
    table_set_matches = expected_tables is None or {(r[1], r[2]) for r in states} == expected_tables
    return {"enabled": sub[1], "tables_ready": (len(states) == len(expected_tables) if expected_tables is not None else len(states) >= 2) and all(r[0] == "r" for r in states) and table_set_matches,
        "replayed_lsn": origin[0] if origin else None}


def subscriber_observation(conn, profile):
    """Dernier message reçu par le subscriber ; aucune connexion à la source."""
    state = progress(conn, profile)
    rows = conn.execute("SELECT last_msg_receipt_time FROM pg_stat_subscription "
        "WHERE subname=%s AND relid IS NULL AND pid IS NOT NULL", (SUBSCRIPTION,)).fetchall()
    receipt = max((r[0] for r in rows if r[0]), default=None)
    return {**state, "last_message_at": int(receipt.timestamp()) if receipt else 0}


def promote_unreachable(target, evidence, timeout=30, profile=None, checkpoint=lambda: None, on_stage=lambda stage: None):
    """Bascule du plan v4 après plusieurs signaux : aucune connexion GCP requise.

    La preuve de panne et l'observation préalable sont vérifiées par le worker.
    Le UUID identifie ici l'incident, PAS une barrière de rattrapage reçue.
    Une réplication asynchrone ne garantit pas zéro perte lors de cette bascule.
    """
    if not target.execute("SELECT pg_try_advisory_lock(726271,1)").fetchone()[0]:
        raise ValueError("Une promotion est déjà en cours.")
    try:
        checkpoint()
        saved = target.execute("SELECT state,barrier,application_profile,promotion_mode,evidence "
            "FROM public.cnp_recovery WHERE singleton").fetchone()
        if saved and (saved[2] != profile or saved[3] != "UNREACHABLE"):
            raise ValueError("Reprise différente du contrat de panne totale.")
        if saved and saved[0] == "AWS_ACTIVE":
            return {"state": "AWS_ACTIVE", "incident": str(saved[1]), "zero_loss_proven": False}
        login = target.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
        if login is None or login[0] or (saved and saved[0] != "PROMOTING"):
            raise ValueError("État cible incompatible avec une promotion.")
        if not saved:
            if not evidence.get("replayed_lsn") or evidence.get("source_unreachable") is not True or \
                    evidence.get("public_unreachable") is not True or not evidence.get("observed_at"):
                raise ValueError("Observations de panne/réplication absentes.")
            state = progress(target, profile)
            if not state["enabled"] or not state["tables_ready"]:
                raise ValueError("Copie initiale incomplète ou abonnement arrêté.")
            incident = uuid4()
            checkpoint()
            target.execute("INSERT INTO public.cnp_recovery(singleton,state,barrier,application_profile,promotion_mode,evidence) "
                "VALUES(true,'PROMOTING',%s,%s,'UNREACHABLE',%s)", (incident, profile, Jsonb(evidence)))
        else:
            incident = saved[1]
        checkpoint()
        on_stage("DISABLING_SUBSCRIPTION")
        stop_subscription(target, timeout, checkpoint, "Worker de réplication encore actif.")
        on_stage("OPENING_AWS")
        with target.transaction():
            checkpoint()
            # Séquences recalées après le maximum répliqué : PostgreSQL ne réplique pas les séquences.
            align_sequences(target, profile)
            target.execute(sql.SQL("ALTER ROLE {} LOGIN").format(sql.Identifier(RUNTIME)))
            target.execute("UPDATE public.cnp_recovery SET state='AWS_ACTIVE' WHERE singleton")
            checkpoint()
        return {"state": "AWS_ACTIVE", "incident": str(incident), "zero_loss_proven": False}
    finally:
        target.execute("SELECT pg_advisory_unlock(726271,1)")


def close_source_runtime(conn):
    # Contrat de recette : seul cnp_runtime écrit des données applicatives.
    # NOLOGIN persiste après redémarrage et interdit les nouvelles connexions.
    conn.execute(sql.SQL("ALTER ROLE {} NOLOGIN").format(sql.Identifier(RUNTIME)))
    conn.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=%s AND pid<>pg_backend_pid()", (RUNTIME,))
    remaining = conn.execute("SELECT count(*) FROM pg_stat_activity WHERE usename=%s", (RUNTIME,)).fetchone()[0]
    login = conn.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
    if remaining or login is None or login[0]:
        raise ValueError("Clôture non prouvée : promotion interdite.")


def fence_source(conn):
    close_source_runtime(conn)
    # Une barrière publiée prouve le rattrapage même sans nouvelle écriture app.
    # Comparer seulement current_wal_lsn serait incorrect : il comprend aussi
    # du WAL de catalogue/non publié, que l'origine logique ne rejoue pas.
    barrier = uuid4()
    conn.execute("INSERT INTO public.replication_barrier(id) VALUES(%s)", (barrier,))
    return barrier


def wait_replay(conn, barrier, timeout=30, checkpoint=lambda: None, profile=None):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        checkpoint()
        state = progress(conn, profile)
        if not state["enabled"]:
            raise ValueError("Abonnement arrêté avant preuve de rattrapage.")
        if state["tables_ready"] and conn.execute("SELECT 1 FROM public.replication_barrier WHERE id=%s", (barrier,)).fetchone():
            return
        time.sleep(0.1)
    raise ValueError("Retard non résorbé : runtime AWS reste fermé.")


def reset_target(target, timeout=30):
    """Vide la copie AWS pour la reconstruire depuis GCP après une migration de l'application (la réplication logique ne
    transporte pas les changements de structure). Seulement sur une copie de secours : runtime fermé, aucune reprise engagée.
    GCP reste la source : aucune donnée ne peut être perdue ; seule la copie est refaite."""
    login = target.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
    if login is None or login[0]:
        raise ValueError("Cible ouverte : la copie de secours ne peut pas être reconstruite.")
    if target.execute("SELECT to_regclass('public.cnp_recovery')").fetchone()[0] and \
            target.execute("SELECT 1 FROM public.cnp_recovery WHERE singleton").fetchone():
        raise ValueError("Reprise engagée : la copie de secours ne peut pas être reconstruite.")
    if target.execute("SELECT 1 FROM pg_subscription WHERE subname=%s", (SUBSCRIPTION,)).fetchone():
        stop_subscription(target, timeout, lambda: None, "Worker de réplication encore actif.")
        # La source est joignable : l'abonnement retire aussi son slot chez elle.
        target.execute(sql.SQL("DROP SUBSCRIPTION {}").format(sql.Identifier(SUBSCRIPTION)))
    # Le schéma public est remis exactement dans son état d'origine en PostgreSQL 15 (propriétaire et droits par défaut).
    target.execute("DROP SCHEMA public CASCADE")
    target.execute("CREATE SCHEMA public AUTHORIZATION pg_database_owner")
    target.execute("GRANT USAGE ON SCHEMA public TO PUBLIC")


# ---------------------------------------------------------------------------------------------------------------------
# Retour manuel vers GCP (failback), lancé par un manager une fois GCP revenu.
#
# AWS sert l'application depuis la bascule ; GCP est revenu mais clôturé (cnp_runtime NOLOGIN, posé par le worker). Le retour
# copie les données d'AWS vers GCP, rouvre GCP, puis la copie AWS redevient un secours reconstruit depuis GCP. Pas de
# réplication inverse continue : le chemin réseau Cloud SQL → RDS n'a jamais été vérifié, et une copie unique, vérifiée, suffit.
#
# L'avancement est inscrit dans cnp_recovery (cible) : AWS_ACTIVE → FAILBACK_FROZEN → FAILBACK_COPIED, puis la ligne disparaît
# avec la remise à zéro de la copie. Le worker refuse tout autre état que PROMOTING/AWS_ACTIVE (BLOCKED_SQL_STATE) : même
# relancé par erreur pendant le retour, il ne rouvre ni ne promeut rien.
# ---------------------------------------------------------------------------------------------------------------------
FAILBACK_STATES = ('AWS_ACTIVE', 'FAILBACK_FROZEN', 'FAILBACK_COPIED')
# Rendu texte identique des deux côtés (même version majeure, mêmes types) : la comparaison ne dépend pas des réglages de session.
CANONICAL_SETTINGS = (("TimeZone", "UTC"), ("DateStyle", "ISO, YMD"), ("IntervalStyle", "postgres"), ("extra_float_digits", "3"),
    ("bytea_output", "hex"))
# Une copie de données peut dépasser le délai de 15 s posé sur les connexions du worker.
COPY_STATEMENT_TIMEOUT = '15min'


def recovery_state(conn):
    """État de reprise inscrit sur une base (None si aucune reprise), sans supposer que la table existe."""
    if not conn.execute("SELECT to_regclass('public.cnp_recovery')").fetchone()[0]:
        return None
    row = conn.execute("SELECT state,application_profile FROM public.cnp_recovery WHERE singleton").fetchone()
    return {'state': row[0], 'profile': row[1]} if row else None


def runtime_can_login(conn):
    row = conn.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
    if row is None:
        raise ValueError("Rôle applicatif absent.")
    return row[0]


def _canonical(conn):
    for name, value in CANONICAL_SETTINGS:
        conn.execute("SELECT set_config(%s,%s,true)", (name, value))


def data_columns(conn, table):
    """Colonnes copiables d'une table : une colonne générée se recalcule, elle ne se copie pas."""
    names = [row[0] for row in conn.execute("SELECT attname FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 "
        "AND NOT attisdropped AND attgenerated='' ORDER BY attnum", ('public.' + table,)).fetchall()]
    if not names:
        raise ValueError("Table sans colonne copiable.")
    return names


def table_checksums(conn, names):
    """Nombre de lignes et somme d'empreintes de lignes, par table : indépendant de l'ordre physique et de la collation."""
    result = {}
    for name in sorted(names):
        columns = sql.SQL(',').join(sql.Identifier(column) for column in data_columns(conn, name))
        count, digest = conn.execute(sql.SQL("SELECT count(*),COALESCE(sum(('x'||substr(md5(r::text),1,15))::bit(60)::bigint),0)::text "
            "FROM (SELECT {} FROM public.{}) r").format(columns, sql.Identifier(name))).fetchone()
        result[name] = [count, digest]
    return result


def failback_freeze_target(target, timeout=30):
    """AWS passe en lecture seule : nouvelles sessions du rôle applicatif en lecture seule, anciennes sessions coupées.

    Les lectures continuent d'être servies pendant la copie. Une écriture qui passerait malgré tout (session qui lèverait
    elle-même la lecture seule) serait vue par la comparaison des empreintes, qui annule la copie.
    """
    started = target.execute("SELECT now()").fetchone()[0]
    target.execute(sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(sql.Identifier(RUNTIME)))
    deadline = time.monotonic() + timeout
    query = "FROM pg_stat_activity WHERE usename=%s AND pid<>pg_backend_pid() AND backend_start < %s"
    while target.execute("SELECT 1 " + query + " LIMIT 1", (RUNTIME, started)).fetchone():
        target.execute("SELECT pg_terminate_backend(pid) " + query, (RUNTIME, started))
        if time.monotonic() >= deadline:
            raise ValueError("Sessions d'écriture AWS encore ouvertes : copie interdite.")
        time.sleep(0.1)


def failback_unfreeze_target(target):
    """Retour arrière avant toute ouverture de GCP : AWS reprend les écritures."""
    target.execute(sql.SQL("ALTER ROLE {} RESET default_transaction_read_only").format(sql.Identifier(RUNTIME)))


def copy_data_to_source(target, source, profile):
    """Remplace les données de l'application sur GCP par celles d'AWS, en une transaction, vérifiée avant validation.

    Les clés étrangères sont retirées puis remises à l'identique dans la même transaction : l'ordre de copie n'a pas
    d'importance (cycles et références à soi-même compris) et leur remise revalide toutes les lignes. Les séquences sont
    recalées après le maximum copié. Toute différence d'empreinte annule la transaction : GCP reste tel qu'il était.
    """
    names = sorted(tables(profile, target))
    if sorted(tables(profile, source)) != names:
        raise ValueError("Tables différentes entre AWS et GCP : aucune copie.")
    for name, value in (*CANONICAL_SETTINGS, ('statement_timeout', COPY_STATEMENT_TIMEOUT)):
        target.execute("SELECT set_config(%s,%s,false)", (name, value))
    try:
        expected = table_checksums(target, names)
        with source.transaction():
            source.execute("SELECT set_config('statement_timeout',%s,true)", (COPY_STATEMENT_TIMEOUT,))
            _canonical(source)
            foreign = source.execute("SELECT t.relname,k.conname,pg_get_constraintdef(k.oid) FROM pg_constraint k "
                "JOIN pg_class t ON t.oid=k.conrelid WHERE k.contype='f' AND k.connamespace='public'::regnamespace ORDER BY 1,2").fetchall()
            for table, name, _ in foreign:
                source.execute(sql.SQL("ALTER TABLE public.{} DROP CONSTRAINT {}").format(sql.Identifier(table), sql.Identifier(name)))
            source.execute(sql.SQL("TRUNCATE {}").format(sql.SQL(',').join(sql.Identifier('public', name) for name in names)))
            for name in names:
                columns = sql.SQL(',').join(sql.Identifier(column) for column in data_columns(target, name))
                # Texte et non binaire : le format binaire transporte l'OID des types (enum, tableaux), propre à chaque serveur.
                with target.cursor().copy(sql.SQL("COPY (SELECT {} FROM public.{}) TO STDOUT").format(columns, sql.Identifier(name))) as out, \
                        source.cursor().copy(sql.SQL("COPY public.{} ({}) FROM STDIN").format(sql.Identifier(name), columns)) as into:
                    for chunk in out:
                        into.write(chunk)
            for table, name, definition in foreign:
                source.execute(sql.SQL("ALTER TABLE public.{} ADD CONSTRAINT {} {}").format(
                    sql.Identifier(table), sql.Identifier(name), sql.SQL(definition)))
            align_sequences(source, profile)
            actual = table_checksums(source, names)
            if actual != expected:
                raise ValueError("Copie vers GCP différente des données AWS : annulée, GCP inchangé.")
            if schema_fingerprint(source) != schema_fingerprint(target):
                raise ValueError("Schéma GCP modifié par la copie : annulée.")
        return {'tables': len(names), 'rows': sum(value[0] for value in expected.values()), 'checksums_equal': True}
    finally:
        target.execute("RESET ALL")


def failback_sync(source, target, profile, timeout=30):
    """Copie AWS → GCP puis réouverture de GCP. Rejouable : chaque étape est inscrite sur la cible avant la suivante.

    Avant : AWS actif (promu), GCP revenu et clôturé, schémas identiques. Après : AWS fermé (NOLOGIN), GCP ouvert avec les
    données d'AWS. Entre les deux, seules les écritures sont refusées ; les lectures restent servies par AWS.
    """
    saved = recovery_state(target)
    if saved is None or saved['profile'] != profile or saved['state'] not in FAILBACK_STATES:
        raise ValueError("Retour impossible : AWS n'est pas la base active de cette application.")
    if saved['state'] == 'FAILBACK_COPIED' and runtime_can_login(source):
        return {'state': 'GCP_OPEN', 'already_done': True}
    if saved['state'] != 'FAILBACK_COPIED':
        # GCP doit être revenu ET clôturé : aucune écriture n'a pu y avoir lieu depuis la bascule.
        if runtime_can_login(source):
            raise ValueError("GCP n'est pas clôturé : retour interdit tant que le worker ne l'a pas fermé.")
        if source.execute("SELECT 1 FROM pg_stat_activity WHERE usename=%s LIMIT 1", (RUNTIME,)).fetchone():
            raise ValueError("Sessions applicatives encore ouvertes sur GCP : retour interdit.")
        if schema_fingerprint(source) != schema_fingerprint(target):
            raise ValueError("Schémas différents entre AWS et GCP : aucune copie automatique.")
        if not target.execute("SELECT pg_try_advisory_lock(726271,2)").fetchone()[0]:
            raise ValueError("Un retour vers GCP est déjà en cours.")
        try:
            target.execute("UPDATE public.cnp_recovery SET state='FAILBACK_FROZEN' WHERE singleton")
            frozen_at = time.monotonic()
            try:
                failback_freeze_target(target, timeout)
                report = copy_data_to_source(target, source, profile)
            except Exception:
                # Rien n'a été validé sur GCP : AWS reprend les écritures, l'application continue sur AWS.
                failback_unfreeze_target(target)
                target.execute("UPDATE public.cnp_recovery SET state='AWS_ACTIVE' WHERE singleton")
                raise
            target.execute("UPDATE public.cnp_recovery SET state='FAILBACK_COPIED' WHERE singleton")
        finally:
            target.execute("SELECT pg_advisory_unlock(726271,2)")
    else:
        report, frozen_at = {'tables': None, 'rows': None, 'checksums_equal': None}, time.monotonic()
    # AWS fermé avant que GCP ne s'ouvre : jamais deux bases ouvertes en écriture. La lecture seule est levée sur un rôle fermé,
    # pour qu'une prochaine promotion rouvre AWS en écriture.
    close_source_runtime(target)
    failback_unfreeze_target(target)
    source.execute(sql.SQL("ALTER ROLE {} LOGIN").format(sql.Identifier(RUNTIME)))
    if not runtime_can_login(source):
        raise ValueError("Réouverture de GCP non prouvée.")
    return {**report, 'state': 'GCP_OPEN', 'already_done': False, 'frozen_seconds': round(time.monotonic() - frozen_at, 1)}


def failback_reset_target(source, target):
    """Après le retour : la copie AWS est vidée pour être reconstruite depuis GCP (même chemin qu'une resynchronisation).

    Exige GCP rouvert et AWS fermé, et un retour inscrit (FAILBACK_COPIED). Rejouable : une copie déjà vidée l'est à nouveau.
    """
    if not runtime_can_login(source):
        raise ValueError("GCP fermé : la copie AWS reste la seule base à jour.")
    if runtime_can_login(target):
        raise ValueError("AWS encore ouvert : retour non terminé.")
    saved = recovery_state(target)
    if saved is not None and saved['state'] != 'FAILBACK_COPIED':
        raise ValueError("Aucun retour vers GCP terminé : la copie AWS n'est pas remise à zéro.")
    if saved is not None:
        target.execute("DELETE FROM public.cnp_recovery WHERE singleton")
    reset_target(target)
    return {'reset': True}


def stop_subscription(target, timeout, checkpoint, blocked):
    """Désactive la souscription puis arrête son processus. Désactivé, il n'est plus relancé ; mais un processus coincé dans sa
    connexion vers une source en panne n'en sort qu'à l'échec TCP : PostgreSQL 15 y ignore connect_timeout (2 min 10 s mesurées
    sur RDS le 06/11/2026, reproduit en local). Il est donc interrompu : il appartient au rôle qui a créé la souscription."""
    target.execute(sql.SQL("ALTER SUBSCRIPTION {} DISABLE").format(sql.Identifier(SUBSCRIPTION)))
    deadline = time.monotonic() + timeout
    while target.execute("SELECT 1 FROM pg_stat_subscription WHERE subname=%s AND pid IS NOT NULL", (SUBSCRIPTION,)).fetchone():
        checkpoint()
        target.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_subscription WHERE subname=%s AND pid IS NOT NULL", (SUBSCRIPTION,))
        if time.monotonic() >= deadline:
            raise ValueError(blocked)
        time.sleep(0.1)


def promote_after_fence(source, target, timeout=30, profile=None, checkpoint=lambda: None, on_stage=lambda stage: None):
    # Procédure manuelle avec preuve fraîche de clôture préalable. Le worker
    # automatique du plan v4 utilise promote_unreachable pour une panne totale.
    if not target.execute("SELECT pg_try_advisory_lock(726271,1)").fetchone()[0]:
        raise ValueError("Une promotion est déjà en cours.")
    try:
        checkpoint()
        saved = target.execute("SELECT state,barrier,application_profile FROM public.cnp_recovery WHERE singleton").fetchone()
        if saved and saved[2] != profile:
            raise ValueError("Profil de reprise différent du contrat initial.")
        if saved and saved[0] == "AWS_ACTIVE":
            return {"state": "AWS_ACTIVE", "barrier": str(saved[1])}
        login = target.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
        if login is None or login[0]:
            raise ValueError("La cible doit encore être fermée aux connexions runtime.")
        if saved:
            if saved[0] != "PROMOTING":
                raise ValueError("État de reprise inconnu : aucune promotion.")
            on_stage("RECHECKING_GCP_FENCE")
            # Reprise après interruption : vérifier à nouveau la clôture réelle,
            # sans insérer de nouvelle barrière dans un abonnement déjà arrêté.
            source_login = source.execute("SELECT rolcanlogin FROM pg_roles WHERE rolname=%s", (RUNTIME,)).fetchone()
            sessions = source.execute("SELECT count(*) FROM pg_stat_activity WHERE usename=%s", (RUNTIME,)).fetchone()[0]
            if source_login is None or source_login[0] or sessions:
                raise ValueError("La clôture GCP n'est plus valide.")
            barrier = saved[1]
        else:
            checkpoint()
            on_stage("FENCING_GCP")
            barrier = fence_source(source)
            on_stage("WAITING_REPLICATION_BARRIER")
            wait_replay(target, barrier, timeout, checkpoint, profile)
            checkpoint()
            target.execute("INSERT INTO public.cnp_recovery(singleton,state,barrier,application_profile) VALUES(true,'PROMOTING',%s,%s)", (barrier,profile))
        checkpoint()
        on_stage("DISABLING_SUBSCRIPTION")
        stop_subscription(target, timeout, checkpoint, "Worker de réplication encore actif ; promotion bloquée.")
        on_stage("OPENING_AWS")
        with target.transaction():
            checkpoint()
            # Séquences recalées après le maximum répliqué : PostgreSQL ne réplique pas les séquences.
            align_sequences(target, profile)
            target.execute(sql.SQL("ALTER ROLE {} LOGIN").format(sql.Identifier(RUNTIME)))
            target.execute("UPDATE public.cnp_recovery SET state='AWS_ACTIVE' WHERE singleton")
            # Une pause/perte du bail avant ce point annule aussi LOGIN : la
            # séquence peut avancer, mais aucun writer AWS n'est alors ouvert.
            checkpoint()
        return {"state": "AWS_ACTIVE", "barrier": str(barrier)}
    finally:
        target.execute("SELECT pg_advisory_unlock(726271,1)")
