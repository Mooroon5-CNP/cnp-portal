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
| `templates/` | gabarit de profil (`postgres`, seul profil depuis le retrait du failover sans base le 08/11/2026) lu par le portail à la création d'un profil |

Détails : `WORKER-PLATEFORME.md` (worker, retour vers GCP), `PROFIL-INTROSPECTE.md` (schéma lu dans la base).

## Images ECS (worker, bootstrap)

Construites depuis ce dossier, qui est le contexte de build :

```sh
cd cnp-portal/scripts/failover/engine
aws ecr get-login-password --region eu-west-3 | docker login --username AWS --password-stdin <ecr>
for k in worker:Dockerfile.automation bootstrap:Dockerfile.bootstrap; do
  docker buildx build --platform linux/amd64 --provenance=false --sbom=false \
    --output type=registry,oci-mediatypes=false \
    -f "${k#*:}" -t "<ecr>/cnp-failover-apps:platform-${k%%:*}-<sha>" .
done
```

`--provenance=false --sbom=false` est **obligatoire** : sans eux, Docker pousse un index avec attestations et, les
tags d'ECR étant immuables, le tag ne garde que le manifeste d'attestation (`in-toto`, ~1,5 Ko) au lieu de l'image ;
ECS ne peut pas la lancer. Constaté le 13/11/2026. Après le push, vérifier
`aws ecr describe-images --repository-name cnp-failover-apps` : `manifest.v2+json` et plusieurs dizaines de Mo.
`linux/amd64` : les tâches déclarent `X86_64`, le poste de build est souvent ARM.

Un seul dépôt ECR, `cnp-failover-apps` ; la pile `platform/` référence les images par digest (`terraform.tfvars`). Toute
nouvelle image passe par l'accord de Gabriel pour le push, puis par un plan de la pile relu avant apply.

## Tests

```sh
python -m unittest discover -s tests -t tests              # sans cloud ni Docker (moteur et générateurs)
python tests/run_docker_postgres.py --scenario introspected # 2 PostgreSQL 15 : réplication, bascule, retour (2 cycles)
python tests/run_docker_postgres.py --scenario total-outage # 2 PostgreSQL 15 : panne totale vue par le worker
python tests/run_docker_dynamodb.py                         # conditions du worker sur un vrai DynamoDB
```
