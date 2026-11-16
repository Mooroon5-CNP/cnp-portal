"""Réplication logique et bascule de la base de PROD d'une app Azure, entre son serveur France et son serveur de copie.

Option B du 15/11/2026 (« allégée ») : la mécanique de la bascule GCP → AWS (réplication logique native, schéma lu dans la
base, recalage des séquences), sans rôle applicatif dédié. Conçue pour que la bascule automatique (option C) n'ait qu'à
appeler les mêmes commandes.

Modèle, symétrique :
- chaque app de prod a deux serveurs, créés par le portail : celui de la région de calcul (tag cnp-role=app-db) et celui de
  la région de copie (cnp-role=copy-db), avec le MÊME administrateur et le MÊME mot de passe ;
- l'app se connecte à un ALIAS DNS par app (CNAME <app>-<env>-db dans la zone privée PostgreSQL). Le serveur que l'alias
  désigne est l'ACTIF ; c'est la seule source de vérité sur le sens de la réplication ;
- `reconcile` (planifié) maintient la réplication de l'actif vers l'autre serveur : il la crée, la reconstruit après une
  bascule, un changement de schéma ou le retour d'un serveur, et ne touche jamais au serveur actif sinon pour publier ;
- `switch` : bascule planifiée, sans perte (actif mis en lecture seule, attente que l'autre ait tout reçu, promotion,
  réécriture de l'alias). Le retour en France après une panne est un `switch` comme un autre ;
- `failover` : bascule quand l'actif ne répond plus. Perte bornée au retard de réplication (quelques centaines de ms
  mesurées le 15/11). Au retour de l'ancien actif, `reconcile` l'efface et le réabonne à l'actif.

Bascule automatique (option C, désactivée par défaut, CNP_AUTO_FAILOVER=true) : `reconcile` déclenche lui-même
`failover` quand l'actif reste injoignable plus de CNP_FAILOVER_AFTER_SECONDS, à condition que l'autre serveur ait été vu
à jour moins de CNP_FRESHNESS_SECONDS avant le début de la panne ; puis, après une bascule AUTOMATIQUE seulement, il revient sur le serveur
d'origine (`switch`, sans perte) quand celui-ci est de nouveau répliqué depuis plus de CNP_FAILBACK_AFTER_SECONDS. Une
bascule faite à la main (`switch`) n'est jamais annulée automatiquement. La mémoire entre deux exécutions (depuis quand
l'actif ne répond pas, dernière réplication saine, raison de la dernière bascule) est rangée dans les MÉTADONNÉES de
l'alias DNS lui-même : aucun stockage de plus, et elle suit l'alias.

Limites, à connaître :
- la coupure de l'actif est un `default_transaction_read_only` sur la base, plus la fin des connexions existantes. Une
  session qui fait explicitement `SET TRANSACTION READ WRITE` passerait : l'app ne le fait pas ;
- un serveur injoignable ne se coupe pas : après un `failover`, il ne doit plus recevoir d'écriture. C'est le cas tant
  que l'app passe par l'alias (aucune connexion directe au FQDN d'un serveur) ;
- un changement de schéma n'est pas répliqué : `reconcile` le voit (empreinte du schéma) et reconstruit la copie.

Aucun secret n'est écrit dans les journaux. Aucune connexion ni appel réseau à l'import.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from psycopg import sql

import database

DATABASE = 'appdb'
PUBLICATION = 'cnp_azure_publication'
SUBSCRIPTION_PREFIX = 'cnp_azure_from_'
# Réglages serveur exigés (constaté le 15/11 sur B1ms : 8 workers ne laissent aucune place à la copie initiale).
REQUIRED_SETTINGS = {'wal_level': 'logical', 'max_worker_processes': '16'}
MAX_SWITCH_LAG_BYTES = 16 * 1024 * 1024
RESTARTING_STATES = ('Restarting', 'Starting', 'Updating')
DOWN_STATES = ('ACTIVE_UNREACHABLE', 'ACTIVE_RESTARTING')


class Server:
    """Un des deux serveurs d'une app. `key` = clé de région (fr, it) : elle nomme l'abonnement qui lit ce serveur."""

    def __init__(self, key, name, fqdn, user):
        self.key, self.name, self.fqdn, self.user = key, name, fqdn, user

    def __repr__(self):
        return f'Server({self.key}, {self.fqdn})'


class Pair:
    def __init__(self, app, env, primary, copy):
        self.app, self.env, self.primary, self.copy = app, env, primary, copy

    @property
    def alias(self):
        return f'{self.app}-{self.env}-db'

    def servers(self):
        return [self.primary, self.copy]

    def by_fqdn(self, fqdn):
        fqdn = (fqdn or '').rstrip('.').lower()
        return next((s for s in self.servers() if s.fqdn.lower() == fqdn), None)

    def other(self, server):
        return self.copy if server is self.primary else self.primary


# --------------------------------------------------------------------------------------------------------------- SQL

def connect(server, password, connect=None, dbname=DATABASE):
    import psycopg
    connect = connect or psycopg.connect
    return connect(host=server.fqdn, port=5432, dbname=dbname, user=server.user, password=password,
                   sslmode=os.environ.get('CNP_AZURE_SSLMODE', 'require'), connect_timeout=5, autocommit=True,
                   application_name='cnp-azure-replication')


def subscription_name(source):
    return SUBSCRIPTION_PREFIX + source.key


def our_subscriptions(conn):
    # subconninfo n'est lisible que par un superutilisateur (l'administrateur Azure ne l'est pas) : la source se lit
    # dans le NOM de l'abonnement.
    return [row[0] for row in conn.execute(
        'SELECT subname FROM pg_subscription WHERE subdbid=(SELECT oid FROM pg_database WHERE datname=current_database()) '
        'AND starts_with(subname, %s) ORDER BY 1', (SUBSCRIPTION_PREFIX,)).fetchall()]


def is_fenced(conn):
    rows = conn.execute("SELECT unnest(setconfig) FROM pg_db_role_setting WHERE setrole=0 "
                        "AND setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())").fetchall()
    return any(row[0] == 'default_transaction_read_only=on' for row in rows)


def fence(conn):
    """Plus aucune écriture de l'app : base en lecture seule pour les nouvelles transactions, connexions existantes closes."""
    name = conn.execute('SELECT current_database()').fetchone()[0]
    conn.execute(sql.SQL('ALTER DATABASE {} SET default_transaction_read_only = on').format(sql.Identifier(name)))
    conn.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() "
                 "AND pid<>pg_backend_pid() AND backend_type='client backend'")


def unfence(conn):
    """Rouvre la base. La session courante, ouverte pendant la coupure, est elle aussi rouverte : le RESET ne vaut que
    pour les sessions suivantes."""
    name = conn.execute('SELECT current_database()').fetchone()[0]
    conn.execute('SET default_transaction_read_only = off')
    conn.execute(sql.SQL('ALTER DATABASE {} RESET default_transaction_read_only').format(sql.Identifier(name)))


def ensure_publication(conn):
    """Publie toutes les tables de l'app (lues dans la base). Une table ajoutée par une migration rejoint la publication."""
    found = database.require_supported(conn)
    for name in found['needs_full_identity']:
        conn.execute(sql.SQL('ALTER TABLE public.{} REPLICA IDENTITY FULL').format(sql.Identifier(name)))
    wanted = {('public', name) for name in found['tables']}
    relations = sql.SQL(', ').join(sql.Identifier('public', name) for _, name in sorted(wanted))
    if not conn.execute('SELECT 1 FROM pg_publication WHERE pubname=%s', (PUBLICATION,)).fetchone():
        conn.execute(sql.SQL('CREATE PUBLICATION {} FOR TABLE {}').format(sql.Identifier(PUBLICATION), relations))
    elif set(conn.execute('SELECT schemaname,tablename FROM pg_publication_tables WHERE pubname=%s', (PUBLICATION,)).fetchall()) != wanted:
        conn.execute(sql.SQL('ALTER PUBLICATION {} SET TABLE {}').format(sql.Identifier(PUBLICATION), relations))
    # Les abonnements se connectent avec l'administrateur ; Azure l'accepte (vérifié le 15/11).
    if not conn.execute('SELECT rolreplication FROM pg_roles WHERE rolname=current_user').fetchone()[0]:
        conn.execute(sql.SQL('ALTER ROLE {} WITH REPLICATION').format(sql.Identifier(conn.info.user)))
    return sorted(name for _, name in wanted)


def drop_subscription(conn, name, remote_reachable=True):
    """Retire un abonnement. Source injoignable : on détache d'abord le slot distant (sinon DROP attend la source)."""
    if not conn.execute('SELECT 1 FROM pg_subscription WHERE subname=%s', (name,)).fetchone():
        return
    ident = sql.Identifier(name)
    if not remote_reachable:
        conn.execute(sql.SQL('ALTER SUBSCRIPTION {} DISABLE').format(ident))
        conn.execute(sql.SQL('ALTER SUBSCRIPTION {} SET (slot_name = NONE)').format(ident))
    conn.execute(sql.SQL('DROP SUBSCRIPTION {}').format(ident))


def drop_local_slots(conn, timeout=10, sleep=time.sleep):
    """Slots laissés sur CE serveur par d'anciens abonnements (détachés par un failover ou par wipe de l'abonné).

    Un slot qui vient d'être lâché peut rester « actif » quelques instants (fin du walsender) : on attend qu'il se libère.
    Un slot resté occupé au-delà est laissé en place et signalé par l'appelant (la création suivante échouera).
    """
    deadline = time.monotonic() + timeout
    while True:
        rows = conn.execute("SELECT slot_name, active FROM pg_replication_slots WHERE starts_with(slot_name, %s)",
                            (SUBSCRIPTION_PREFIX,)).fetchall()
        for slot, active in rows:
            if not active:
                conn.execute('SELECT pg_drop_replication_slot(%s)', (slot,))
        if not any(active for _, active in rows) or time.monotonic() >= deadline:
            return
        sleep(0.5)


def wipe(conn):
    """Vide la base d'un serveur NON actif avant de le réabonner : abonnements, publication, slots, schéma, coupure."""
    unfence(conn)
    for name in our_subscriptions(conn):
        drop_subscription(conn, name, remote_reachable=False)
    conn.execute(sql.SQL('DROP PUBLICATION IF EXISTS {}').format(sql.Identifier(PUBLICATION)))
    drop_local_slots(conn)
    conn.execute('DROP SCHEMA public CASCADE')
    conn.execute('CREATE SCHEMA public')


def copy_schema(source_conn, target_conn, dump):
    """Schéma de l'actif restauré sur l'autre serveur (fonction partagée avec le moteur GCP → AWS)."""
    return database.copy_schema(source_conn, target_conn, dump)


def subscribe(conn, source, password, name):
    conninfo = ' '.join([f'host={source.fqdn}', 'port=5432', f'dbname={DATABASE}', f'user={source.user}',
                         f"sslmode={os.environ.get('CNP_AZURE_SSLMODE', 'require')}",
                         "password='" + password.replace('\\', '\\\\').replace("'", "\\'") + "'"])
    conn.execute(sql.SQL('CREATE SUBSCRIPTION {} CONNECTION {} PUBLICATION {} WITH (copy_data = true)').format(
        sql.Identifier(name), sql.Literal(conninfo), sql.Identifier(PUBLICATION)))


def replication_state(source_conn, target_conn, name):
    """État observé (aucune écriture) : tables prêtes, slot actif, retard en octets, schémas identiques."""
    sub = target_conn.execute('SELECT oid, subenabled FROM pg_subscription WHERE subname=%s', (name,)).fetchone()
    if sub is None:
        return {'subscribed': False}
    states = [row[0] for row in target_conn.execute('SELECT srsubstate::text FROM pg_subscription_rel WHERE srsubid=%s', (sub[0],)).fetchall()]
    slot = source_conn.execute('SELECT active, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) '
                               'FROM pg_replication_slots WHERE slot_name=%s', (name,)).fetchone()
    published = {row[0] for row in source_conn.execute('SELECT tablename FROM pg_publication_tables WHERE pubname=%s', (PUBLICATION,)).fetchall()}
    tables = set(database.discover(source_conn)['tables'])
    return {
        'subscribed': True, 'enabled': sub[1], 'tables': len(states),
        'tables_ready': bool(states) and all(s == 'r' for s in states) and len(states) == len(tables),
        'slot_active': bool(slot and slot[0]), 'lag_bytes': int(slot[1]) if slot and slot[1] is not None else None,
        'publication_complete': published == tables,
        'schema_in_sync': database.schema_fingerprint(source_conn) == database.schema_fingerprint(target_conn),
    }


def wait_caught_up(source_conn, name, timeout=30, sleep=time.sleep):
    """Attend que l'abonné ait confirmé tout le WAL écrit sur la source au moment de l'appel."""
    target = source_conn.execute('SELECT pg_current_wal_lsn()').fetchone()[0]
    deadline = time.monotonic() + timeout
    while True:
        row = source_conn.execute('SELECT pg_wal_lsn_diff(confirmed_flush_lsn, %s) FROM pg_replication_slots WHERE slot_name=%s',
                                  (target, name)).fetchone()
        if row and row[0] is not None and row[0] >= 0:
            return str(target)
        if time.monotonic() >= deadline:
            raise TimeoutError("L'autre serveur n'a pas reçu toutes les écritures : bascule annulée, l'actif est rouvert.")
        sleep(0.2)


def promote(conn, source_reachable=True):
    """Le serveur abonné devient autonome : abonnement retiré, séquences recalées (non répliquées par PostgreSQL)."""
    unfence(conn)
    for name in our_subscriptions(conn):
        drop_subscription(conn, name, remote_reachable=source_reachable)
    with conn.transaction():
        database.align_sequences(conn, None)


# ------------------------------------------------------------------------------------------------------- Orchestration

class Engine:
    """Les décisions, indépendantes d'Azure : `platform` fournit les paires, l'alias, le mot de passe et les réglages."""

    def __init__(self, platform, connect=connect, dump=None, log=print, sleep=time.sleep, auto=None, clock=time.time):
        self.platform, self._connect, self.log, self.sleep, self.clock = platform, connect, log, sleep, clock
        self.dump = dump or self._dump_with_pg_dump
        self.auto = auto  # AutoPolicy, ou None : aucune bascule automatique

    def _dump_with_pg_dump(self, server, password):
        params = {'host': server.fqdn, 'port': 5432, 'user': server.user, 'password': password, 'dbname': DATABASE,
                  'sslmode': os.environ.get('CNP_AZURE_SSLMODE', 'require')}
        return lambda: database.dump_schema(params)

    def _open(self, server, password):
        try:
            return self._connect(server, password)
        except Exception:  # noqa: BLE001 — la cause peut contenir l'hôte et l'utilisateur : on ne la relaie pas.
            return None

    def _open_standby(self, server, password):
        """Comme _open, mais crée la base de l'app si elle manque : le portail ne la crée que sur le serveur de l'app
        (FlexibleServerDatabase), pas sur le serveur de copie (constaté le 16/11 sur la prod : « database appdb does not
        exist », STANDBY_UNREACHABLE en boucle). Elle est créée vide ; reconcile y copie ensuite le schéma."""
        conn = self._open(server, password)
        if conn is not None:
            return conn
        try:
            admin = self._connect(server, password, dbname='postgres')
        except Exception:  # noqa: BLE001 — serveur vraiment injoignable : rien à créer.
            return None
        with admin:
            if admin.execute('SELECT 1 FROM pg_database WHERE datname=%s', (DATABASE,)).fetchone():
                return None  # la base existe : l'échec de connexion a une autre cause
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DATABASE)))
            self.log(json.dumps({'event': 'DATABASE_CREATED', 'server': server.key, 'database': DATABASE}))
        return self._open(server, password)

    def _report(self, pair, **fields):
        record = {'app': pair.app, 'env': pair.env, **fields}
        self.log(json.dumps(record, ensure_ascii=False, sort_keys=True))
        return record

    def active(self, pair, create=True):
        target = self.platform.alias_get(pair)
        if target is None:
            if not create:
                return None
            self.platform.alias_set(pair, pair.primary.fqdn, {})
            return pair.primary
        server = pair.by_fqdn(target)
        if server is None:
            raise ValueError(f"L'alias {pair.alias} désigne {target}, qui n'est aucun des deux serveurs de l'app.")
        return server

    def reconcile_pair(self, pair, apply=True):
        """`apply=False` (commande status) : observation seule, aucune écriture nulle part."""
        active = self.active(pair, create=apply)
        if active is None:
            return self._report(pair, state='NO_ALIAS')
        standby = pair.other(active)
        # État Azure de chaque serveur ; « unknown » si Azure ne répond pas (panne de la région, par exemple) : on ne
        # s'arrête pas là, c'est la connexion PostgreSQL qui tranche.
        states = {server.key: self.platform.server_state(server) for server in pair.servers()}
        if apply:
            for server in pair.servers():
                if states[server.key] == 'Ready':
                    changed = self.platform.ensure_settings(server, REQUIRED_SETTINGS)
                    if changed:
                        return self._report(pair, active=active.key, state='SETTINGS_APPLYING', detail=changed)
        password = self.platform.password(pair)
        src = self._open(active, password)
        if src is None:
            # Redémarrage en cours (le nôtre pour les réglages, ou une maintenance Azure) : pas une panne, tant qu'il ne
            # dure pas (voir AutoPolicy.restart_grace).
            restarting = states[active.key] in RESTARTING_STATES
            return self._report(pair, active=active.key, state='ACTIVE_RESTARTING' if restarting else 'ACTIVE_UNREACHABLE',
                                server_state=states[active.key])
        with src:
            dst = self._open_standby(standby, password) if apply else self._open(standby, password)
            if dst is None:
                return self._report(pair, active=active.key, state='STANDBY_UNREACHABLE')
            with dst:
                name = subscription_name(active)
                if is_fenced(src) and not apply:
                    return self._report(pair, active=active.key, state='ACTIVE_FENCED')
                if is_fenced(src):
                    # Bascule interrompue entre la coupure et la promotion : l'autre serveur est encore abonné à l'actif,
                    # rien n'a changé de main. On rouvre l'actif plutôt que de laisser l'app en lecture seule.
                    if name in our_subscriptions(dst):
                        unfence(src)
                        self.log(json.dumps({'app': pair.app, 'env': pair.env, 'event': 'ACTIVE_REOPENED'}))
                    else:
                        return self._report(pair, active=active.key, state='ACTIVE_FENCED')
                if not database.discover(src)['tables']:
                    return self._report(pair, active=active.key, state='WAITING_SCHEMA')
                state = replication_state(src, dst, name)
                healthy = (state.get('subscribed') and state['publication_complete'] and state['schema_in_sync']
                           and set(our_subscriptions(dst)) == {name})
                if not healthy and not apply:
                    return self._report(pair, active=active.key, standby=standby.key, state='NEEDS_RESYNC', **state)
                if not healthy:
                    self._resync(pair, active, standby, src, dst, password, reason=state)
                    state = replication_state(src, dst, name)
                ready = state.get('tables_ready') and state.get('slot_active')
                return self._report(pair, active=active.key, standby=standby.key,
                                    state='REPLICATING' if ready else 'SYNCING', **state)

    def _resync(self, pair, active, standby, src, dst, password, reason):
        self.log(json.dumps({'app': pair.app, 'env': pair.env, 'event': 'RESYNC', 'from': active.key, 'to': standby.key,
                             'reason': {k: v for k, v in reason.items() if k in ('subscribed', 'schema_in_sync', 'publication_complete')}}))
        # Jamais sur l'actif : `standby` est par construction l'autre serveur que celui de l'alias.
        assert standby is not active
        wipe(dst)
        # L'abonnement retiré par wipe a pu laisser son slot sur l'actif (détaché sans le supprimer) : il bloquerait la
        # création du nouveau, qui porte le même nom.
        drop_local_slots(src, sleep=self.sleep)
        ensure_publication(src)
        copy_schema(src, dst, self.dump(active, password))
        # La copie du schéma finit par RESET ALL, qui remet la session dans l'état de son ouverture : si l'ancien actif était
        # encore coupé (lecture seule) à ce moment-là, la session redevient lecture seule et CREATE SUBSCRIPTION échoue
        # (constaté au premier retour sur Azure le 16/11 ; le passage suivant réussissait, 2 minutes perdues).
        dst.execute('SET default_transaction_read_only = off')
        subscribe(dst, active, password, subscription_name(active))

    def reconcile(self, apply=True):
        results = []
        for pair in self.platform.pairs():
            try:
                result = self.reconcile_pair(pair, apply)
                if apply:
                    result = self._remember_and_decide(pair, result) or result
                results.append(result)
            except Exception as error:  # noqa: BLE001 — une app en erreur n'empêche pas les autres.
                results.append(self._report(pair, state='ERROR', error=type(error).__name__, detail=str(error)[:300]))
        return results

    def _remember_and_decide(self, pair, result):
        """Met à jour la mémoire de l'alias, puis applique la politique automatique (option C) si elle est activée."""
        meta = dict(self.platform.alias_meta(pair) or {})
        before, now, state = dict(meta), int(self.clock()), result.get('state')
        if state in DOWN_STATES:
            meta.setdefault('unreachable_since', str(now))
        else:
            meta.pop('unreachable_since', None)
        if state == 'REPLICATING':
            meta['last_replicating'] = str(now)
            meta.setdefault('replicating_since', str(now))
        else:
            meta.pop('replicating_since', None)
        if meta != before:
            self.platform.alias_set(pair, self.platform.alias_get(pair), meta)
        if self.auto is None:
            return None
        decision = self.auto.decide(pair, result, meta, now)
        if decision == 'failover':
            return self.failover(pair, reason='auto')
        if decision == 'failback':
            return self.switch(pair, reason='auto-failback')
        if decision:
            return self._report(pair, **{**result, 'auto': decision})
        return None

    def switch(self, pair, timeout=30, reason='manual'):
        """Bascule planifiée vers l'autre serveur, sans perte. Refusée si la réplication n'est pas prête."""
        active = self.active(pair)
        standby = pair.other(active)
        password = self.platform.password(pair)
        src, dst = self._open(active, password), self._open(standby, password)
        if src is None or dst is None:
            raise RuntimeError('Les deux serveurs doivent répondre pour une bascule planifiée (sinon : failover).')
        with src, dst:
            name = subscription_name(active)
            state = replication_state(src, dst, name)
            if not (state.get('tables_ready') and state.get('slot_active') and state.get('schema_in_sync')):
                raise RuntimeError(f'Réplication pas prête : {json.dumps(state, sort_keys=True)}')
            if state['lag_bytes'] is not None and state['lag_bytes'] > MAX_SWITCH_LAG_BYTES:
                raise RuntimeError(f"Retard de réplication trop grand ({state['lag_bytes']} octets).")
            started = time.monotonic()
            fence(src)
            try:
                lsn = wait_caught_up(src, name, timeout, self.sleep)
            except Exception:
                unfence(src)
                raise
            promote(dst, source_reachable=True)
            # Bascule planifiée : la mémoire repart de zéro (et une bascule faite à la main n'est pas annulée seule).
            self.platform.alias_set(pair, standby.fqdn, {'reason': reason})
            return self._report(pair, event='SWITCHED', active=standby.key, previous=active.key, fenced_lsn=lsn, reason=reason,
                                write_pause_ms=int((time.monotonic() - started) * 1000))

    def failover(self, pair, attempts=3, force=False, reason='manual'):
        """Bascule quand l'actif ne répond plus. Refusée s'il répond (utiliser switch), sauf `force`."""
        active = self.active(pair)
        standby = pair.other(active)
        password = self.platform.password(pair)
        if not force:
            for attempt in range(attempts):
                conn = self._open(active, password)
                if conn is not None:
                    conn.close()
                    raise RuntimeError("L'actif répond : bascule planifiée (switch) plutôt que failover.")
                if attempt + 1 < attempts:
                    self.sleep(5)
        dst = self._open(standby, password)
        if dst is None:
            raise RuntimeError("L'autre serveur ne répond pas non plus : aucune bascule possible.")
        with dst:
            if subscription_name(active) not in our_subscriptions(dst):
                raise RuntimeError("L'autre serveur n'était pas abonné à l'actif : ses données ne sont pas à jour.")
            promote(dst, source_reachable=False)
        self.platform.alias_set(pair, standby.fqdn, {'reason': 'failover-' + reason, 'failed_over_at': str(int(self.clock()))})
        return self._report(pair, event='FAILED_OVER', active=standby.key, previous=active.key, reason=reason)

    def find(self, app, env='prod'):
        pair = next((p for p in self.platform.pairs() if p.app == app and p.env == env), None)
        if pair is None:
            raise ValueError(f'Aucune paire de serveurs pour {app}/{env}.')
        return pair


class AutoPolicy:
    """Option C : quand basculer seul, quand revenir seul. Décision pure (aucun appel), testable sans base."""

    def __init__(self, failover_after=90, freshness=600, failback_after=600, restart_grace=600):
        self.failover_after, self.freshness, self.failback_after = failover_after, freshness, failback_after
        # Un serveur qu'Azure dit en redémarrage n'est pas en panne : on lui laisse ce délai avant de basculer.
        self.restart_grace = max(restart_grace, failover_after)

    @classmethod
    def from_environ(cls, environ):
        if environ.get('CNP_AUTO_FAILOVER', '').lower() != 'true':
            return None
        return cls(int(environ.get('CNP_FAILOVER_AFTER_SECONDS', 90)), int(environ.get('CNP_FRESHNESS_SECONDS', 600)),
                   int(environ.get('CNP_FAILBACK_AFTER_SECONDS', 600)), int(environ.get('CNP_RESTART_GRACE_SECONDS', 600)))

    def decide(self, pair, result, meta, now):
        state, active = result.get('state'), result.get('active')
        if state in DOWN_STATES:
            down = now - int(meta.get('unreachable_since', now))
            limit = self.restart_grace if state == 'ACTIVE_RESTARTING' else self.failover_after
            if down < limit:
                return f'waiting-failover-{limit - down}s'
            # Fraîcheur mesurée au DÉBUT de la panne, pas maintenant : pendant une panne longue, plus rien n'arrive de
            # toute façon. La question est « l'autre serveur était-il à jour quand l'actif est tombé ? ».
            fresh = int(meta.get('unreachable_since', now)) - int(meta.get('last_replicating', 0))
            if fresh > self.freshness:
                # L'autre serveur n'a pas été vu à jour récemment : basculer servirait des données périmées. Un humain
                # décide (failover à la main, en connaissance de cause).
                return 'failover-refused-stale-standby'
            return 'failover'
        if (state == 'REPLICATING' and active != pair.primary.key and meta.get('reason') == 'failover-auto'
                and now - int(meta.get('replicating_since', now)) >= self.failback_after):
            return 'failback'
        return None


# ---------------------------------------------------------------------------------------------------------------- Azure

class AzurePlatform:
    """Accès Azure par l'identité managée du job (aucun secret) : serveurs par tag, alias DNS, coffre, réglages."""

    ARM = 'https://management.azure.com'

    def __init__(self, environ=None, opener=None):
        env = environ if environ is not None else os.environ
        self.subscription = env['AZURE_SUBSCRIPTION_ID']
        self.primary_rg, self.primary_key = env['PRIMARY_RESOURCE_GROUP'], env.get('PRIMARY_KEY', 'fr')
        self.copy_rg, self.copy_key = env['COPY_RESOURCE_GROUP'], env.get('COPY_KEY', 'it')
        self.zone_rg, self.zone = env['DNS_ZONE_RESOURCE_GROUP'], env['DNS_ZONE']
        self.vault = env['VAULT_NAME']
        self.client_id = env.get('UAMI_CLIENT_ID')
        self.identity_endpoint, self.identity_header = env.get('IDENTITY_ENDPOINT'), env.get('IDENTITY_HEADER')
        self.open = opener or urllib.request.urlopen
        self._tokens = {}

    def _token(self, resource):
        if resource not in self._tokens:
            query = {'resource': resource, 'api-version': '2019-08-01'}
            if self.client_id:
                query['client_id'] = self.client_id
            req = urllib.request.Request(self.identity_endpoint + '?' + urllib.parse.urlencode(query),
                                         headers={'X-IDENTITY-HEADER': self.identity_header})
            with self.open(req, timeout=10) as res:
                self._tokens[resource] = json.load(res)['access_token']
        return self._tokens[resource]

    def _call(self, method, url, body=None, resource=ARM):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self._token(resource), 'Content-Type': 'application/json'})
        try:
            with self.open(req, timeout=30) as res:
                raw = res.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise RuntimeError(f'{method} {url.split("?")[0].rsplit("/providers/", 1)[-1]} : HTTP {error.code}') from None

    def _rg(self, rg):
        return f'{self.ARM}/subscriptions/{self.subscription}/resourceGroups/{rg}'

    def _servers(self, rg, role, key):
        found = self._call('GET', self._rg(rg) + '/providers/Microsoft.DBforPostgreSQL/flexibleServers?api-version=2024-08-01') or {}
        for item in found.get('value', []):
            tags = item.get('tags') or {}
            if tags.get('cnp-role') == role and tags.get('cnp-app') and tags.get('cnp-env') and tags.get('cnp-env') != 'dev':
                props = item['properties']
                yield (tags['cnp-app'], tags['cnp-env']), Server(key, item['name'], props['fullyQualifiedDomainName'],
                                                                 props['administratorLogin'])

    def pairs(self):
        copies = dict(self._servers(self.copy_rg, 'copy-db', self.copy_key))
        return [Pair(app, env, server, copies[(app, env)])
                for (app, env), server in self._servers(self.primary_rg, 'app-db', self.primary_key) if (app, env) in copies]

    def _record(self, pair):
        return (self._rg(self.zone_rg) + f'/providers/Microsoft.Network/privateDnsZones/{self.zone}/CNAME/{pair.alias}'
                '?api-version=2020-06-01')

    def _alias_record(self, pair):
        record = self._call('GET', self._record(pair))
        return record and record['properties']

    def alias_get(self, pair):
        record = self._alias_record(pair)
        return record and record.get('cnameRecord', {}).get('cname')

    def alias_meta(self, pair):
        record = self._alias_record(pair) or {}
        return {k: v for k, v in (record.get('metadata') or {}).items() if k not in ('cnp_app', 'cnp_env')}

    def alias_set(self, pair, fqdn, meta=None):
        # TTL 30 s : c'est lui qui borne le temps pendant lequel l'app résout encore l'ancien serveur. Les métadonnées
        # (chaînes seulement) portent la mémoire de la bascule automatique ; None les conserve telles quelles.
        if meta is None:
            meta = self.alias_meta(pair)
        self._call('PUT', self._record(pair), {'properties': {'ttl': 30, 'cnameRecord': {'cname': fqdn},
                                                              'metadata': {'cnp_app': pair.app, 'cnp_env': pair.env, **meta}}})

    def password(self, pair):
        url = f'https://{self.vault}.vault.azure.net/secrets/{pair.app}-{pair.env}-pg-password?api-version=7.4'
        secret = self._call('GET', url, resource='https://vault.azure.net')
        if not secret:
            raise RuntimeError(f'Secret {pair.app}-{pair.env}-pg-password absent du coffre.')
        return secret['value']

    def _server_url(self, server):
        rg = self.primary_rg if server.key == self.primary_key else self.copy_rg
        return self._rg(rg) + f'/providers/Microsoft.DBforPostgreSQL/flexibleServers/{server.name}'

    def server_state(self, server):
        try:
            found = self._call('GET', self._server_url(server) + '?api-version=2024-08-01')
        except Exception:  # noqa: BLE001 — Azure injoignable : la connexion PostgreSQL tranchera.
            return 'unknown'
        return (found or {}).get('properties', {}).get('state') or 'absent'

    def ensure_settings(self, server, settings):
        """Pose les réglages manquants et redémarre le serveur s'il le faut. Renvoie ce qui a changé (vide sinon)."""
        base = self._server_url(server)
        changed, pending = [], False
        for name, value in settings.items():
            current = self._call('GET', base + f'/configurations/{name}?api-version=2024-08-01')['properties']
            if current['value'] != value:
                self._call('PUT', base + f'/configurations/{name}?api-version=2024-08-01', {'properties': {'value': value, 'source': 'user-override'}})
                changed.append(name)
            elif current.get('isConfigPendingRestart'):
                pending = True
        # Azure applique un réglage de façon ASYNCHRONE : redémarrer juste après l'écriture redémarrait parfois avant que le
        # second réglage soit pris, et il fallait un redémarrage de plus (trois au lieu d'un sur la prod du 16/11). On écrit
        # donc lors d'une exécution, et on ne redémarre qu'à une suivante, une seule fois, quand Azure annonce tous les
        # réglages en place et en attente de redémarrage.
        if pending and not changed:
            self._call('POST', base + '/restart?api-version=2024-08-01', {})
            changed.append('restart')
        return changed


def main(argv=None, platform=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('reconcile')
    sub.add_parser('status')
    for name in ('switch', 'failover'):
        cmd = sub.add_parser(name)
        cmd.add_argument('app')
        cmd.add_argument('--env', default='prod')
        if name == 'failover':
            cmd.add_argument('--force', action='store_true', help="bascule même si l'actif répond (perte possible)")
    args = parser.parse_args(argv)
    engine = Engine(platform or AzurePlatform(), auto=AutoPolicy.from_environ(os.environ))
    if args.command in ('reconcile', 'status'):
        results = engine.reconcile(apply=args.command == 'reconcile')
        return 1 if any(r.get('state') == 'ERROR' for r in results) else 0
    pair = engine.find(args.app, args.env)
    if args.command == 'switch':
        engine.switch(pair)
    else:
        engine.failover(pair, force=args.force)
    return 0


if __name__ == '__main__':
    sys.exit(main())
