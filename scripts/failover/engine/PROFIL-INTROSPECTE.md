# Profil PostgreSQL introspecté

Le schéma d'une application n'est plus **décrit** (JSON de tables saisi à la main) : il est **lu dans sa base**. Le profil
se réduit au nom de la base :

```json
{ "sql_contract": { "database": "appdb" } }
```

encodé en `postgres:{"database":"appdb"}` dans la configuration du worker. Les profils historiques `recipe` et
`pixelcalm`, et la forme déclarative `{database, tables}`, restent acceptés le temps de leur retrait.

## Pourquoi

L'ancien contrat recréait sur le standby des tables réduites à leurs colonnes : **ni valeurs par défaut, ni index uniques,
ni clés étrangères, ni CHECK, ni énumérations, ni extensions**. La réplication logique copie les lignes, pas les contraintes :
après une bascule l'application aurait tourné sur un schéma appauvri.

## Ce que CNP fait

Le schéma n'existe qu'une fois l'application démarrée : l'initialisation SQL est donc **en deux phases**, séparées par le démarrage de
l'application sur GCP. Parcours du portail (profil introspecté) :

| Étape du portail | Opérations SQL | Effet |
|---|---|---|
| `bootstrap-plan` | — | Tâche d'initialisation disponible (plan Terraform relu) |
| `bootstrap-roles` | `create-target-runtime` | Rôle applicatif de la cible, `NOLOGIN` |
| candidat `runtime`, `runtime-verify` | — | L'application démarre sur GCP (et son standby sur AWS) ; elle crée son schéma |
| `schema-check` | `inspect-source` | Lecture seule. **Attend** que la source ait des tables (« l'appeler une fois »), **bloque** avec la liste d'un schéma non pris en charge |
| `bootstrap` | `prepare-source`, `restore-schema`, `prepare-target`, `verify-native-tls`, `subscribe` | Voir ci-dessous |
| `verify` | `verify-replication` | Rejeu d'une écriture fraîche **et** `schema_in_sync` vrai (sa seule absence ne suffit pas) |

Détail de la phase 2 :

| Opération | Effet |
|---|---|
| `prepare-source` | Refuse ce qui n'est pas pris en charge (rien n'est modifié). Pose `REPLICA IDENTITY FULL` sur les tables sans clé primaire. Crée la publication sur les tables lues |
| `restore-schema` | `pg_dump --schema-only` de la source, restauré sur la cible **vide** (extensions, types, tables, contraintes, index, vues, séquences). Les empreintes de schéma des deux côtés doivent être égales |
| `prepare-target` | Tables techniques CNP, droits du rôle applicatif |
| `verify-native-tls`, `subscribe` | Abonnement logique, copie initiale |

À la promotion, les séquences sont alignées d'après le catalogue de la cible. Un profil historique garde l'ancien enchaînement en une
seule phase.

## Contrat applicatif v1

1. PostgreSQL uniquement (ou aucune base : parcours sans base).
2. Tables dans le schéma `public`. Une table sans clé primaire est acceptée (`REPLICA IDENTITY FULL`).
3. **Le schéma existe sur la source avant la réplication.** Une application qui crée son schéma au premier appel d'API doit avoir
   été appelée une fois ; sinon `prepare-source` répond « Aucune table applicative… » au lieu de répliquer du vide.
4. Configuration par variables : `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSLMODE`,
   `DB_SSLROOTCERT_PEM` (le certificat, à écrire dans un fichier pour `sslrootcert`).
5. `/healthz` : processus vivant, **indépendant de la base** (le standby a le rôle applicatif `NOLOGIN` avant promotion).
   `/health` : prête, base inscriptible.
6. Séquences `serial` ou identité : pas 1, minimum 1, sans cycle, rattachées à une colonne.
7. **Pas de DDL quand le schéma existe déjà.** Le rôle applicatif n'a pas le droit de créer dans `public` une fois
   `restrict_cloudsql_runtime` appliqué, ni sur la cible après bascule. Un `CREATE TABLE IF NOT EXISTS` exécuté à chaque démarrage
   échoue alors avec « permission denied for schema public » **même si la table existe** (PostgreSQL contrôle le droit avant
   l'existence). L'application doit tester la présence (`to_regclass`) avant de créer.

## Points à vérifier sur une vraie instance (non reproductibles avec Docker)

- **Propriété des tables sur Cloud SQL.** L'application crée son schéma en tant que `cnp_runtime`, membre de `cloudsqlsuperuser` : elle en
  est propriétaire. L'administrateur doit pouvoir poser `REPLICA IDENTITY FULL` (propriété requise) et `pg_dump` doit pouvoir verrouiller
  ces tables. En Docker l'administrateur est superutilisateur, donc ce cas n'est pas couvert. À contrôler à la première exécution cloud.

## Ce qui est refusé, et dit explicitement

Tables hors de `public`, tables partitionnées, vues matérialisées (leurs données ne se répliquent pas), séquences non
rattachées à une colonne ou hors du cas ci-dessus, schéma vide. Extension de la source absente sur la cible : refus avant toute
écriture. Cible non vide et différente de la source : « aucune migration automatique ».

## Évolutions de schéma (DDL)

La réplication logique ne réplique pas le DDL. Une migration appliquée d'un seul côté est **détectée** (`schema_in_sync` faux
dans `verify-replication` et `monitor`), pas corrigée. Règle : appliquer la migration sur la cible, puis sur la source.

## Image du bootstrap

`Dockerfile.bootstrap` installe le client PostgreSQL (`pg_dump`). Un client plus récent que le serveur est accepté : les
`SET` de session que la cible ne connaît pas (par exemple `transaction_timeout`, ajouté par le client 17) sont retirés du
script avant exécution. Un client **plus ancien** que le serveur est refusé par `pg_dump`. `CNP_PG_DUMP` impose un autre binaire.
**L'image doit être reconstruite et publiée par digest** avant de lancer `restore-schema` dans le cloud.

## Profils historiques : retirés le 07/11/2026

Les profils `recipe` et `pixelcalm` du pilote, la forme déclarative `{database, tables}`, `manage.py`, `recipe_app.py`,
`Dockerfile.worker` et leurs tests ont été retirés avec le pilote `app4-pixelcam` et le régime historique du worker. Le seul
profil PostgreSQL est `{"database": "<nom>"}` ; promotion et retour recalent les séquences découvertes dans la base.

## Tests

- Sans Docker : `python -m unittest tests.test_introspected_postgres`.
- Scénario réaliste (deux PostgreSQL 15 jetables, vrai `pg_dump`) : `python tests/run_docker_postgres.py --scenario introspected`.
  `CNP_LOCAL_DUMP_IMAGE=<image>` rejoue le même scénario avec le `pg_dump` d'une autre image, par exemple celle du bootstrap.
