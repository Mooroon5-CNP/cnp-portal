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
| `CNP_FAILOVER_ENGINE_ROOT` | Racine du moteur (contient `safe_apply.py`, `credentials/`, `automation/`). Une valeur fausse **échoue**, sans repli silencieux | détection des deux dispositions |
| `CNP_FAILOVER_CONFIG_REPO` | Racine du `config-repo` (générateurs et modèles de profil) | dépôt voisin du portail |
| `CNP_FAILOVER_PLATFORM` | Fichier des paramètres de plateforme (voir plus bas) | `data/failover-platform.json` |
| `CNP_FAILOVER_SETTINGS` | Paramètres partagés historiques du pilote (profil, varfiles du worker) | `../phase1-deployment-20261029/portal-settings.json` |
| `CNP_FAILOVER_PYTHON` | Python des générateurs (PyYAML requis) | `python3` |
| `CNP_FAILOVER_OPERATOR_PYTHON` | Python de l'opérateur (boto3, psycopg requis) | `CNP_FAILOVER_PYTHON`, sinon `python3` |

`CNP_FAILOVER_SETTINGS` reste nécessaire tant que le worker partagé porte la configuration du pilote : ses varfiles
(bootstrap, worker, activation) servent à ne jamais retirer une application déjà configurée. Ils devront un jour être
reconstruits depuis les sorties Terraform.

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
    "kube_context": "<contexte kubectl explicite>",
    "subscription_tls_mode": "wireguard-tls",
    "acknowledge_wireguard_subscriber_trust": true
  }
}
```

Champs obligatoires : tous ceux de `gcp` et `aws`, et dans `automation` : `worker_image`, `ecs_cluster_arn`,
`ecs_security_group_id`, `public_subnet_ids`, `subscription_ca_path_on_rds`, `kube_context`. Un fichier incomplet est
refusé en nommant les champs manquants, et aucun profil n'est enregistré.

## Poste local

- **Node 22** (`.nvmrc`). La CI utilise Node 22 ; une autre version peut ne pas charger `better-sqlite3`.
- **Python** : un environnement durable, hors dossier temporaire (chemins de la disposition imbriquée ; en dépôts côte à
  côte, remplacer `../deployment/` par `../cnp/deployment/`).

  ```sh
  python3 -m venv .venv-failover
  .venv-failover/bin/pip install -r ../deployment/failover-phase1/requirements.automation.txt \
    -r ../config-repo/scripts/requirements.phase1.txt
  export CNP_FAILOVER_PYTHON="$PWD/.venv-failover/bin/python"
  ```

- `terraform`, `gcloud` et `kubectl` disponibles, avec les accès de l'environnement cible.
- Les tests du portail exigent un `config-repo` voisin (modèles de profil et générateurs).

## Portail déployé (à prévoir)

Ce qui manque aujourd'hui à l'image du portail pour exécuter le failover : Python opérateur, `terraform`, `gcloud`,
`kubectl`, le moteur et le `config-repo` (variables `CNP_FAILOVER_ENGINE_ROOT` et `CNP_FAILOVER_CONFIG_REPO`), un stockage
persistant pour la base SQLite et `data/failover-operations/`, et une identité cloud. L'opérateur suppose une seule instance
du portail partageant cet état.
