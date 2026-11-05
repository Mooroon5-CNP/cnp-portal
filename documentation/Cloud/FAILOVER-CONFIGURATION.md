# Failover — configuration du portail (local et déployé)

Ce document décrit tout ce dont le failover générique a besoin **hors du code** : variables d'environnement, fichier de
paramètres de plateforme, outils. Rien ici n'est propre à une application. Il remplace les chemins implicites de la
première version (dépôts « côte à côte », dossier `phase1-deployment-…` local).

## Disposition des dépôts

Le portail reconnaît deux dispositions sans configuration :

| Disposition | Moteur (`failover-phase1`) | `config-repo` |
|---|---|---|
| Dépôts côte à côte | `<projet>/cnp/deployment/failover-phase1` | `<projet>/config-repo` |
| Portail imbriqué dans `cnp` | `cnp/deployment/failover-phase1` | `cnp/config-repo` |

Pour toute autre disposition (et pour un portail déployé), imposer les chemins avec les variables ci-dessous.

## Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `CNP_FAILOVER_ENGINE_ROOT` | Racine du moteur (contient `bootstrap.py`, `automation.py`, `platform_secrets.py`). Une valeur fausse **échoue**, sans repli silencieux | détection des deux dispositions |
| `CNP_FAILOVER_CONFIG_REPO` | Racine du `config-repo` (générateurs et modèles de profil) | dépôt voisin du portail |
| `CNP_FAILOVER_PLATFORM` | Fichier des paramètres de plateforme (voir plus bas) | `data/failover-platform.json` |
| `CNP_FAILOVER_SETTINGS` | Paramètres partagés historiques du pilote (profil, varfiles du worker) | `../phase1-deployment-20261029/portal-settings.json` |
| `CNP_FAILOVER_PYTHON` | Python des générateurs (PyYAML requis) | `python3` |
| `CNP_FAILOVER_OPERATOR_PYTHON` | Python de l'opérateur (`requirements.platform.txt` du moteur) | `CNP_FAILOVER_PYTHON`, sinon `python3` |

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

- **Node 22** (`.nvmrc`). La CI utilise Node 22 ; une autre version peut ne pas charger `better-sqlite3`.
- **Python** : un environnement durable, hors dossier temporaire (chemins de la disposition imbriquée ; en dépôts côte à
  côte, remplacer `../deployment/` par `../cnp/deployment/`).

  ```sh
  python3 -m venv .venv-failover
  .venv-failover/bin/pip install -r ../deployment/failover-phase1/requirements.platform.txt \
    -r ../config-repo/scripts/requirements.phase1.txt
  export CNP_FAILOVER_PYTHON="$PWD/.venv-failover/bin/python"
  ```

- **Aucune CLI** (`terraform`, `gcloud`, `kubectl`) : tout passe par les API, avec les identifiants de l'environnement
  (identifiants par défaut de Google, profil AWS, kubeconfig). Un garde-fou de test refuse tout lancement de processus.
- Les tests du portail exigent un `config-repo` voisin (modèles de profil et générateurs).

## Portail déployé (à prévoir)

Ce qui manque aujourd'hui à l'image du portail pour exécuter le failover : Python opérateur (`requirements.platform.txt`), le
moteur et le `config-repo` (variables `CNP_FAILOVER_ENGINE_ROOT` et `CNP_FAILOVER_CONFIG_REPO`), un stockage persistant pour la
base SQLite et `data/failover-operations/`, et une identité cloud. L'opérateur suppose une seule instance du portail partageant
cet état. Plus aucune CLI n'est nécessaire.

Droits de l'identité du portail (à créer par la pile plateforme) :

| Où | Droits |
|---|---|
| AWS | ECS : lancer et lire les tâches `cnp-failover-platform-*` (et leur passer leur rôle), lire les services ; journaux des tâches ; Secrets Manager sur `cnp/failover/*` (voir `WORKER-PLATEFORME.md`) ; Route 53, DynamoDB (table d'état), EventBridge, ELB en lecture ; `sts:GetCallerIdentity` |
| GCP | `run.services.get`, `cloudsql.instances.get`, Secret Manager (voir `WORKER-PLATEFORME.md`) |
| Kubernetes | découverte des API ; `get` sur les ressources Crossplane observées (`databaseinstances`, `instances` RDS, `healthchecks`) ; `get` et `create` sur les `secrets` de `crossplane-system` |
