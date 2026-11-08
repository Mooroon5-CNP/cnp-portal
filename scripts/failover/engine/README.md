# Failover GCP → AWS — moteur

Tout le Python du failover, en **un seul endroit** depuis le 08/11/2026 : il était réparti entre
`cnp/deployment/failover-phase1` (moteur) et `config-repo/scripts` (générateurs, gabarits), et le portail les trouvait
« à côté » de lui sur le disque. Ce dossier est copié dans l'image du portail et sert aussi à construire les images ECS.
L'infrastructure (Terraform `platform/`, `foundation/`, `crossplane-access/`) reste dans `cnp/deployment/failover-phase1`.
Les démonstrations de panne et de retour (soutenance) sont dans `../demo` : elles utilisent `gcloud` et `kubectl` et ne
sont pas copiées dans l'image.

| Fichier | Rôle |
|---|---|
| `automation.py` | worker : surveillance, bascule sur panne, verrou DNS, retour vers GCP (`failback-route`, `rearm`) — image `Dockerfile.automation` |
| `bootstrap.py` | initialisation SQL : rôles, schéma lu puis restauré, abonnement, vérification, resynchronisation, copie de retour — image `Dockerfile.bootstrap` |
| `database.py` | opérations PostgreSQL (introspection du schéma, réplication logique, promotion, retour) |
| `platform_secrets.py` | secrets d'une app, créés par API depuis son Secret Kubernetes (utilisé par le portail) |
| `postgres_contract.py` | profil PostgreSQL `{"database": "<nom>"}` (copie unique) |
| `prepare_failover_phase1.py`, `render_*.py` | générateurs des manifestes GitOps (Crossplane) publiés dans le config-repo |
| `templates/` | gabarits de profil (`postgres`, `stateless`) lus par le portail à la création d'un profil |

Détails : `WORKER-PLATEFORME.md` (worker, retour vers GCP), `PROFIL-INTROSPECTE.md` (schéma lu dans la base).

## Images ECS (worker, bootstrap)

Construites depuis ce dossier, qui est le contexte de build :

```sh
cd cnp-portal/scripts/failover/engine
docker build -f Dockerfile.automation -t <ecr>/cnp-failover-apps:platform-worker-<sha> .
docker build -f Dockerfile.bootstrap  -t <ecr>/cnp-failover-apps:platform-bootstrap-<sha> .
```

Un seul dépôt ECR, `cnp-failover-apps` ; la pile `platform/` référence les images par digest (`terraform.tfvars`). Toute
nouvelle image passe par l'accord de Gabriel pour le push, puis par un plan de la pile relu avant apply.

## Tests

```sh
python -m unittest discover -s tests -t tests              # sans cloud ni Docker (moteur et générateurs)
python tests/run_docker_postgres.py --scenario introspected # 2 PostgreSQL 15 : réplication, bascule, retour (2 cycles)
python tests/run_docker_postgres.py --scenario total-outage # 2 PostgreSQL 15 : panne totale vue par le worker
python tests/run_docker_dynamodb.py                         # conditions du worker sur un vrai DynamoDB
```
