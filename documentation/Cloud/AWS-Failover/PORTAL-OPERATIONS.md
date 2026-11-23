# Failover — configuration du portail (local et déployé)

Ce document décrit tout ce dont le failover générique a besoin **hors du code** : variables d'environnement, fichier de
paramètres de plateforme, outils. Rien ici n'est propre à une application. Il remplace les chemins implicites de la
première version (dépôts « côte à côte », dossier `phase1-deployment-…` local).

## Où est le code

Tout le Python du failover (moteur, worker, bootstrap, générateurs, gabarits de profil, tests) est dans ce dépôt, dans
`scripts/failover/engine/`, depuis le 08/11/2026 : une seule copie, la même sur un poste et dans l'image. Plus besoin de
dépôts voisins (`cnp`, `config-repo`) pour exécuter le failover.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `CNP_FAILOVER_ENGINE_ROOT` | Autre moteur à essayer (contient `bootstrap.py`). Une valeur fausse **échoue**, sans repli silencieux | `scripts/failover/engine` |
| `CNP_FAILOVER_PLATFORM` | Fichier des paramètres de plateforme (voir plus bas) | `data/failover-platform.json` |
| `CNP_FAILOVER_SETTINGS` | Paramètres partagés historiques du pilote (profil, varfiles du worker) | `../phase1-deployment-20261029/portal-settings.json` |
| `CNP_FAILOVER_PYTHON` | Python des générateurs (PyYAML requis) | `python3` |
| `CNP_FAILOVER_OPERATOR_PYTHON` | Python de l'opérateur (`requirements.platform.txt` du moteur) | `CNP_FAILOVER_PYTHON`, sinon `python3` |
| `CNP_FAILOVER_STEP_BY_STEP` | **Temporaire (premier passage cloud, G5).** `true` : chaque publication GitOps attend la revue manager. À retirer après la recette de panne | absent : approbation automatique |

**Approbation des publications.** Par défaut, la mise en service lancée par un manager est la seule décision humaine : chaque
publication (`databases`, `runtime`, `dns`, `worker`) est contrôlée puis approuvée automatiquement en son nom. Contrôles : ceux
d'une approbation manuelle (profil et images inchangés, PR ouverte sur le commit préparé, `main` inchangé, merge par le bot), plus
le contenu (fichiers dans le dossier de l'app, routage modifié seulement par `runtime`, ressources référencées présentes,
`deletionPolicy: Orphan` partout sauf l'alarme et la configuration du worker). Un contrôle en échec bloque la mise en service avec sa
raison ; rien n'est publié, la proposition reste à rejeter avant reprise.

`CNP_FAILOVER_SETTINGS` ne sert plus qu'au pilote (vérifications de son état). Le portail ne lance **plus aucun plan
Terraform** : l'infrastructure partagée du failover (tables, worker, déclencheurs, tâches ECS) est créée une fois par la pile
plateforme, appliquée par un humain ; ce qui est propre à une app passe par GitOps (Crossplane) ou par les API.

## Paramètres de plateforme : `failover-platform.json`

Valeurs communes à toutes les applications. Un profil neuf est construit depuis ce fichier ; **le profil du pilote n'est plus
nécessaire**. Sans fichier, le portail retombe sur l'ancien comportement (lecture du profil du pilote via
`CNP_FAILOVER_SETTINGS`), puis échoue en nommant le chemin attendu.

Le fichier contient des identifiants d'infrastructure (aucun secret). Il reste hors Git (`data/` est ignoré).

```json
{
  "gcp": {
    "gcp_lb_ip": "<IPv4 du load balancer GCP (sortie Terraform apps_lb_ip)>",
    "gcp_runtime": {
      "service_account": "<compte de service d'exécution Cloud Run>",
      "subnetwork": "<sous-réseau pour Direct VPC egress>"
    }
  },
  "aws": {
    "database_security_group_id": "sg-…",
    "database_ca_pem": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"
  },
  "automation": {
    "worker_image": "<registre>/cnp-failover-apps@sha256:…",
    "ecs_cluster_arn": "arn:aws:ecs:…",
    "ecs_security_group_id": "sg-…",
    "public_subnet_ids": ["subnet-…"],
    "subscription_ca_path_on_rds": null,
    "kube_context": null,
    "subscription_tls_mode": "wireguard-tls",
    "acknowledge_wireguard_subscriber_trust": true,
    "bootstrap_task_definition": "cnp-failover-platform-bootstrap",
    "worker_task_definition": "cnp-failover-platform-worker"
  }
}
```

Champs obligatoires : tous ceux de `gcp` et `aws`, et dans `automation` : `worker_image`, `ecs_cluster_arn`,
`ecs_security_group_id`, `public_subnet_ids`, `subscription_ca_path_on_rds`, `kube_context`. Un fichier incomplet est
refusé en nommant les champs manquants, et aucun profil n'est enregistré.

Toute app PostgreSQL neuve est créée en **régime plateforme** ; il faut donc aussi les deux tâches ECS de la pile plateforme
(`bootstrap_task_definition`, `worker_task_definition`, noms fixes ci-dessus). `kube_context` vaut `null` dans le cluster
(identité du pod) ; sur un poste, c'est le contexte du kubeconfig à utiliser.

## Poste local

Pour lancer le portail avec le Python nécessaire à PostgreSQL (y compris Cloud SQL dev sans failover), depuis `cnp-portal/` :

```sh
npm run dev:postgres
```

Arrêter auparavant l’ancienne instance du portail si elle occupe le même port. Ce démarrage prépare `data/.venv-failover`,
installe les dépendances figées de `requirements.platform.txt`, vérifie leurs imports, puis lance le portail en définissant
`CNP_FAILOVER_OPERATOR_PYTHON` et `CNP_FAILOVER_PYTHON`. Il nécessite un Python avec `venv`/`ensurepip` et l’accès au dépôt de
paquets. Sur Debian/Ubuntu, installer le paquet `python3-venv` correspondant au Python utilisé s’il manque.

Après une installation réussie, le lanceur conserve une empreinte des trois fichiers de dépendances et de la version Python.
Au démarrage suivant, si cette empreinte est identique, que les imports fonctionnent et que `pip check` passe, il démarre sans
relancer l’installation. Un changement de dépendances ou un environnement cassé déclenche une nouvelle préparation. Un échec
d’installation ou de vérification empêche le lancement du portail et ne marque pas un nouvel environnement comme prêt.

### Authentification Google après l’installation

Les imports Python peuvent réussir alors que l’identité Google nécessaire à Secret Manager manque. Le client Python utilise
les Application Default Credentials (ADC), distinctes du jeton Kubernetes du portail et de la simple connexion CLI `gcloud auth login`.
Pour un portail lancé sur un poste local, avec le même utilisateur système :

```sh
gcloud auth application-default login
```

Terminer la connexion dans le navigateur, puis utiliser « Réessayer la configuration » sur le déploiement existant. Il n’est pas
nécessaire de supprimer l’application ou de réinstaller Python. Dans une image déployée, configurer l’identité de workload/service
prévue plutôt qu’une connexion utilisateur interactive. Voir la [documentation Google ADC locale](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment).

L’opérateur affiche désormais une consigne explicite pour les erreurs ADC absentes ou expirées et pour les dépendances Python
connues manquantes. Il ne renvoie jamais le texte brut de ces exceptions ; les erreurs inconnues gardent le message générique,
afin de ne pas exposer de mot de passe, de jeton ou de réponse d’authentification.

### Installation qui cherche de nombreuses versions Google

Le message pip « looking at multiple versions » correspond au [backtracking du résolveur](https://pip.pypa.io/en/stable/topics/dependency-resolution/),
avant le démarrage du portail. La version `google-cloud-secret-manager==2.21.1` conservée par la plateforme impose Protobuf `<6` ;
des versions plus récentes de dépendances Google/gRPC exigent Protobuf 6 ou ultérieur et provoquaient une recherche très longue.

`requirements.platform.txt` fixe désormais cette famille indirecte : `google-api-core==2.24.2`,
`googleapis-common-protos==1.70.0`, `grpc-google-iam-v1==0.14.2`, `proto-plus==1.26.1`,
`protobuf==5.29.6`, `grpcio==1.76.0` et `grpcio-status==1.71.2`. Le client Secret Manager et le code de déploiement ne sont pas
mis à niveau par ce changement. Sources : [contraintes Secret Manager](https://github.com/googleapis/google-cloud-python/blob/google-cloud-secret-manager-v2.21.1/packages/google-cloud-secret-manager/setup.py),
[API Core](https://github.com/googleapis/python-api-core/blob/v2.24.2/pyproject.toml),
[gRPC Status](https://github.com/grpc/grpc/blob/v1.71.2/src/python/grpcio_status/setup.py).

Si une installation antérieure est encore en train de résoudre les anciennes dépendances, l’arrêter avec `Ctrl+C`, puis
relancer `npm run dev:postgres` depuis `cnp-portal/`. Il n’est pas nécessaire de supprimer l’application ou l’environnement virtuel.
Cette correction a été vérifiée sur les contraintes publiées pour Python 3.12/3.13/3.14 et par cinq tests de lancement isolés.
L’installation complète et les imports réels de ces versions restent à vérifier avec un accès réseau : le bac à sable de
l’intervention ne permet pas leur téléchargement ni l’ouverture du port du portail.

Un interpréteur explicitement fourni par ces variables est vérifié sans installation implicite de paquets dedans.
`CNP_BOOTSTRAP_PYTHON` permet de choisir le Python utilisé pour créer le nouvel environnement virtuel. Les identités
Kubernetes et Google doivent aussi être configurées pour les opérations cloud ; cette commande vérifie les bibliothèques,
sans créer de base ni de secret. Elle ne modifie pas le choix de facturation Cloud Run de l’application.

- **Node 22** (`.nvmrc`). La CI utilise Node 22 ; une autre version peut ne pas charger `better-sqlite3`.
- **Python** : un environnement durable, hors dossier temporaire (chemins de la disposition imbriquée ; en dépôts côte à
  côte, remplacer `../deployment/` par `../cnp/deployment/`).

  ```sh
  python3 -m venv data/.venv-failover
  data/.venv-failover/bin/pip install -r scripts/failover/engine/requirements.platform.txt
  export CNP_FAILOVER_PYTHON="$PWD/data/.venv-failover/bin/python"
  ```

- **Aucune CLI** (`terraform`, `gcloud`, `kubectl`) : tout passe par les API, avec les identifiants de l'environnement
  (identifiants par défaut de Google, profil AWS, kubeconfig). Un garde-fou de test refuse tout lancement de processus.
- Un test du portail (`failover-environment.test.js`) lit encore le contenu GitOps réel d'un `config-repo` voisin pour simuler GitHub.

## Portail déployé

L'image embarque Python (`/opt/failover`, avec `requirements.platform.txt`) et `scripts/failover/` (tests exclus) ;
`CNP_FAILOVER_PYTHON` et `CNP_FAILOVER_OPERATOR_PYTHON` y sont réglées. Reste au déploiement : un stockage persistant pour la
base SQLite et `data/failover-operations/`, le fichier de plateforme (`CNP_FAILOVER_PLATFORM`, sans `kube_context`), et
l'identité cloud (voir `cnp/Runbook/PORTAIL-CLUSTER.md`). L'opérateur suppose une seule instance du portail partageant cet
état. Plus aucune CLI n'est nécessaire.

Droits de l'identité du portail (à créer par la pile plateforme) :

| Où | Droits |
|---|---|
| AWS | ECS : lancer et lire les tâches `cnp-failover-platform-*` (et leur passer leur rôle), lire les services ; journaux des tâches ; Secrets Manager sur `cnp/failover/*` (voir `WORKER-PLATEFORME.md`) ; Route 53, DynamoDB (table d'état), EventBridge, ELB en lecture ; `sts:GetCallerIdentity` |
| GCP | `run.services.get`, `cloudsql.instances.get`, Secret Manager (voir `WORKER-PLATEFORME.md`) |
| Kubernetes | découverte des API ; `get` sur les ressources Crossplane observées (`databaseinstances`, `instances` RDS, `healthchecks`) ; `get` et `create` sur les `secrets` de `crossplane-system` |
