# Worker de bascule — régime « plateforme »

Le même `automation.py` sert deux régimes. Le régime est choisi par la présence de la variable `CNP_CONFIG_TABLE`.

| | Régime pilote (historique) | Régime plateforme |
|---|---|---|
| Configuration des apps | JSON dans `CNP_AUTOMATION_CONFIG` (définition de tâche ECS) | **Table DynamoDB** de configuration, lue à chaque exécution |
| Table d'état | `cnp-failover-automation` | `cnp-failover-platform-state` |
| Table de configuration | — | `cnp-failover-platform-config` |
| Topic SNS | `cnp-failover-automation` | `cnp-failover-platform` |
| Alarme d'une app | `cnp-failover-<app>` | `cnp-failover-platform-<app>` |
| Nombre d'apps | 1 à 10 | 0 à 200 |

Les noms sont contrôlés **hors ligne, avant toute session AWS**. Une variable fausse (par exemple la table du pilote avec le régime plateforme)
arrête le worker sans qu'il appelle AWS. Le préfixe d'alarme de la plateforme ne recoupe **pas** celui du pilote : une règle EventBridge sur
`cnp-failover-platform-` ne capte jamais `cnp-failover-app4-pixelcam`.

## Format de la table de configuration

Un enregistrement par app : `app` (clé, texte) et `config` (texte) qui contient la configuration de l'app en JSON, avec les mêmes champs et les
mêmes contrôles que `CNP_AUTOMATION_CONFIG` (hôte, sondes Route 53, ARN de secrets, certificats publics, plage `10.189.0.0/16`). Aucune valeur secrète.
Une valeur nulle équivaut à une valeur absente : l'empreinte ne dépend pas de l'outil qui écrit l'enregistrement.

## Ce que le worker garantit

- **Une configuration invalide ne retire jamais les autres apps.** Elle est signalée (`BLOCKED_INVALID_CONFIG`, code de sortie 1) et les apps valides
  sont traitées normalement.
- **Une configuration modifiée n'agit pas.** Chaque prise de bail, point de contrôle, pause et transition exige l'empreinte de la configuration
  qui a été configurée puis vérifiée. Si la configuration déclarée change (par exemple par GitOps), l'app passe en `BLOCKED_CONFIG_CHANGED` : aucune action,
  aucune prise de bail, **une alerte SNS par version modifiée** (`CNP failover CONFIG_CHANGED`) et la raison dans les journaux. Il faut relancer
  `configure`, vérifier, puis `resume`.
- **Aucune app configurée : rien à faire.** Le worker ne bloque pas et ne notifie pas.
- Le worker **lit** la table de configuration, il ne l'écrit jamais. Terraform ne fait que créer la table ; seul GitOps (Crossplane) en renseigne les enregistrements.

## Le pilote et le régime historique

Retirés le 07/11/2026 : app `app4-pixelcam` détruite, piles Terraform `automation/` et `credentials/` détruites puis supprimées
du dépôt, worker `cnp-failover-automation` et ses déclencheurs disparus. Le worker refuse toute configuration hors de la table
de la plateforme (`PLATFORM_CONFIG_TABLE_REQUIRED`). La politique Route 53 de Crossplane a été reprise par `platform/`.

## Droits IAM nécessaires (pour L1)

Table de configuration : `dynamodb:Scan` seulement. Table d'état : lecture et écriture, y compris les transactions.
Le fournisseur Crossplane n'a, lui, aucun droit sur la table d'état.

## Tests

- Sans Docker : `python -m unittest tests.test_platform_worker`.
- Contre un **vrai DynamoDB** (image officielle AWS, conteneur jetable) : `python tests/run_docker_dynamodb.py`. Vérifie la pagination réelle, les conditions
  d'empreinte, la transaction état + événement, l'alerte unique par version et la commande complète.

## Qui écrit la configuration (L3)

Le générateur (`render_worker_phase1.py`, étape `worker` de `prepare_failover_phase1.py`) publie par GitOps, pour chaque app en
régime plateforme (`automation.regime = "platform"`), deux ressources Crossplane :

- l'alarme `cnp-failover-platform-<app>` (CloudWatch, `us-east-1`, même définition que l'ancienne ressource Terraform) ;
- l'enregistrement de configuration de l'app dans `cnp-failover-platform-config` (`TableItem`).

Ni l'une ni l'autre ne porte `deletionPolicy: Orphan` : retirer l'app retire sa configuration, donc le worker cesse d'agir pour elle.
Dans ce régime, le mot de passe administrateur de RDS est celui du Secret Kubernetes de l'app (clé `target-admin-password`), copié dans
`cnp/failover/<app>/target-admin` : le worker n'a besoin d'aucun droit sur les secrets gérés par RDS (nom aléatoire).
Le pilote garde son régime, sa pile Terraform et le secret géré par RDS.

Le test `tests/test_generator_contract.py` vérifie que ce que le générateur écrit est accepté tel quel par `automation.validate` et donne la même
empreinte (toujours exécuté : générateur et worker sont dans ce dossier depuis le 08/11/2026).

## Secrets d'une app (L4)

`platform_secrets.py` remplace, pour le régime plateforme, la pile Terraform `credentials/` **et** `initialize_secrets.py` (qui appelait
`kubectl` et `gcloud`). L'opération du portail `initialize-secrets` l'appelle ; `credentials-plan` y est refusé.

| Ordre | Objet | Contenu | Lecteur |
|---|---|---|---|
| 1 (origine) | Secret Kubernetes `crossplane-system/cnp-<app>-sql` | les 5 mots de passe | Crossplane (Cloud SQL, RDS : clé `target-admin-password`) |
| 2 | AWS `cnp/failover/<app>/bootstrap` | `app`, `schema_version: 1` et les 4 mots de passe du pilote | tâche bootstrap |
| 2 | AWS `cnp/failover/<app>/source-admin`, `runtime`, `target-admin` | `username` / `password` (`postgres`, `cnp_runtime`, `cnp_owner`) | bootstrap, worker, ECS |
| 3 | GCP `<app>-prod-runtime` | mot de passe runtime, une version, lecture par le compte runtime | Cloud Run |

Relançable : le Secret Kubernetes existant fait foi (jamais régénéré) et refait les copies perdues ; une valeur différente, un objet non créé par
la plateforme pour cette app (étiquette `ManagedBy`/`managed-by` = `cnp-platform`) ou en cours de suppression arrête tout. La politique IAM du
secret GCP est réécrite avec son etag (aucun droit d'autrui écrasé). Aucune valeur n'est renvoyée ni journalisée.

Bibliothèques : `requirements.platform.txt`. Identités : celles de l'environnement (pod du portail dans le cluster, sinon poste de l'opérateur ;
`kube_context` du profil hors cluster).

**Droits à donner à l'identité du portail (L1) :**
- AWS, sur `arn:aws:secretsmanager:eu-west-3:626278345026:secret:cnp/failover/*` : `CreateSecret`, `TagResource`, `DescribeSecret`,
  `GetSecretValue`, `PutSecretValue` (plus `sts:GetCallerIdentity`) ;
- GCP, projet `cnp-terraform-512313` : `secretmanager.secrets.{create,get,getIamPolicy,setIamPolicy}`, `secretmanager.versions.{add,list,access}` ;
- Kubernetes : `get` et `create` sur `secrets` dans `crossplane-system` (pas `update`, `patch` ni `delete`).

Non couvert : le retrait des secrets quand une app est supprimée (comme pour le pilote, ils restent, à supprimer à la main).

## Portail sans CLI ni plan (L5)

Le portail ne lance plus `terraform`, `gcloud` ni `kubectl`, et les actions `credentials-plan`, `bootstrap-plan`, `automation-plan`,
`activation-plan` et `apply` n'existent plus (garde-fou : `cnp-portal/scripts/failover/tests/test_operate.py`, `NoCommandLineTests`).

| Avant | Maintenant |
|---|---|
| `gcloud run services describe` | API Cloud Run v2 (`terminalCondition`, `reconciling`, révisions prête et créée, image) |
| `kubectl get` des ressources Crossplane | API Kubernetes, à la **version préférée du cluster** (celle que prenait `kubectl` : `rds` en `v1beta3`, pas la `v1beta2` écrite dans Git) |
| `gcloud sql instances describe` (CA de la source) | API Cloud SQL Admin `instances.get` — le statut Crossplane ne publie pas `serverCaCert` |
| ARN de tâche issu des sorties d'un plan | noms fixes de la pile plateforme, portés par la configuration de plateforme |

Une sonde Route 53 absente (404) reste normale avant la publication DNS ; toute autre erreur de lecture arrête désormais l'opération
(avant, `kubectl` en échec était ignoré en silence).

**Noms que la pile plateforme (L1) doit créer**, attendus tels quels par le portail et le générateur :
- tâches ECS `cnp-failover-platform-bootstrap` et `cnp-failover-platform-worker` (sans suffixe de version) ;
- règles EventBridge `cnp-failover-platform-alarm` et `cnp-failover-platform-retry`, ciblant la tâche du worker ;
- table d'état `cnp-failover-platform-state` (mêmes clés `app` / `record` que celle du pilote) et table `cnp-failover-platform-config`.

## Retour manuel vers GCP (7/11/2026)

Jamais automatique : un manager clique « Revenir sur GCP » quand le voyant « GCP disponible » est allumé. Le voyant vient
du contrôle de santé d'une app servie par AWS : Cloud SQL démarrée (`RUNNABLE`/`ALWAYS`), ressource Crossplane reprise et
prête, Cloud Run prêt, et base GCP jointe puis clôturée par le worker (`source_fence = GCP_FENCED`). Une lecture refusée
l'éteint.

Étapes du portail (phase `failback` de `failover-provisioning.js`) :

| Étape | Qui | Effet |
|---|---|---|
| `failback-check` | portail (lecture) | AWS actif, voyant allumé |
| `worker-pause` | worker | plus aucun passage automatique |
| `worker-failback-route` | worker (`failback-route`) | verrou DNS de GCP rouvert ; sans effet tant que GCP est fermé (sa sonde `/health` échoue) |
| `failback-sync` | bootstrap | AWS en lecture seule → copie AWS→GCP en une transaction, vérifiée par table (lignes + empreinte), séquences recalées, clés étrangères revalidées → AWS fermé → GCP ouvert. Route 53 rend le trafic à GCP de lui-même (~30 s) |
| `failback-reset` | bootstrap | copie AWS vidée (abonnement et slot GCP supprimés) puis reconstruite par l'initialisation habituelle |
| `verify`, `worker-rearm`, `worker-verify`, `verify`, `worker-resume`, `health` | | worker réarmé (contrôle repris à `DISABLED`, en pause), puis réactivé : WAIT_SIGNALS |

Données : le retour ne perd rien. Écritures refusées (pas perdues) pendant la copie ; toute différence d'empreinte annule la
copie (GCP inchangé, AWS rouvert en écriture) ; AWS fermé avant que GCP s'ouvre ; remise à zéro refusée tant que GCP n'est
pas rouvert avec la copie. Avancement inscrit sur RDS (`cnp_recovery` : `AWS_ACTIVE` → `FAILBACK_FROZEN` →
`FAILBACK_COPIED`) : chaque étape est rejouable, et le worker refuse ces états (`BLOCKED_SQL_STATE`). Seule perte admise
(décision de Gabriel, 7/11) : le RPO de la bascule GCP→AWS (quelques secondes de réplication asynchrone non reçues), écrasé
par la copie, sans sauvegarde. Entre la réouverture de GCP et le retour en WAIT_SIGNALS (~10-15 min), pas de secours.

Tests : `python tests/run_docker_postgres.py --scenario introspected` (cycle GCP→AWS→GCP→AWS→GCP, gel, annulation d'une
copie fausse), `python tests/run_docker_dynamodb.py` (conditions de `failback-route` et `rearm`). Démo : `demo-retour.sh`.
Exige les images bootstrap ET worker reconstruites (nouvelles opérations).
