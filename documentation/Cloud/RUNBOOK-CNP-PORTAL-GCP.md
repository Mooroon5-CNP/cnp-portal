# CNP Portal on GKE — deployment runbook

## Current release (verified 21 November 2026)

- Project: `cnp-terraform-512313`; cluster: `cnp-cluster-terraform` in `europe-west9-b`.
- Portal source: `Mooroon5-CNP/cnp-portal`, branch `main`, overlay `k8s/overlays/prod`.
- GitOps source: `Mooroon5-CNP/config-repo`, branch `main`, applications `cert-manager`, `cnp-portal-bootstrap`, `cnp-portal`.
- URL: `https://portal.apps.mooroon5.fr` via ingress-nginx `34.163.88.46`.
- One pod, `Recreate` rollout, SQLite on `cnp-portal-data` (10 Gi `standard-rwo`). A rollout interrupts active sessions. Do not increase replicas without migrating the database and session store.
- MCP UI and code remain present. The real MCP-CNP service is a later promotion; the current client uses test data.
- Both the portal and the dedicated OpenBao runtime provisioner currently use image `sha256:6769759244337d47ed4ba2fdde1adc69a94fdf70bd2d371e7f633e190c32edd9`. On 21 November both Deployments were `1/1`, Argo CD reported `Synced/Healthy` for the portal and Dancing Duck prod, and `/api/health` returned `ok` for GitHub, Argo CD, Datadog, Kubernetes and Crossplane. Recheck these facts before each release; they are a dated observation, not a permanent guarantee.
- [OpenBao deployment status from 20 November](../openbao/ETAT-DEPLOIEMENT-20261120.md) is an archived incident snapshot. It predates the provisioner and later AWS failover work; do not use its blocked-mode table as current readiness.
- GCP OpenBao is configured and the portal JWT login has been verified. Azure OpenBao and the current `cnp/cluster` AWS and private OpenBao endpoints also accepted the portal pod's JWT during read-only checks. The private JWT audience is `https://openbao.prive.apps.mooroon5.fr:8200` **without a trailing slash**; the slash form returns HTTP 400. Application runtime identities and real variable delivery still require verification before these modes can be declared ready.

## Recreate the platform bootstrap

Use a `kubectl` context for the project above. Apply the reviewed `config-repo` main manifests, in order:

```sh
kubectl apply -f argocd/projects/cert-manager.yaml -f argocd/apps/cert-manager.yaml
kubectl -n cert-manager rollout status deployment/cert-manager --timeout=120s
kubectl -n cert-manager rollout status deployment/cert-manager-webhook --timeout=120s
kubectl apply -f argocd/projects/cnp-portal-bootstrap.yaml -f argocd/apps/cnp-portal-bootstrap.yaml
kubectl apply -f argocd/projects/cnp-portal.yaml -f argocd/apps/cnp-portal.yaml
kubectl -n argocd get applications cert-manager cnp-portal-bootstrap cnp-portal
kubectl get clusterissuer letsencrypt-prod
kubectl get record.route53.aws.upbound.io cnp-portal-public
```

The first application installs pinned cert-manager; the second owns the Let's Encrypt issuer and Route53 record. The portal application is intentionally manual sync. Keep the Crossplane Route53 provider and ingress-nginx load balancer available. DNS is `portal.apps.mooroon5.fr → 34.163.88.46` in zone `Z0043335ESJGO8F4BE96`.

## Recreate application configuration

Terraform supplies the `cnp-portal` Kubernetes service account, GCP OpenBao CA ConfigMap, and `cnp-portal-cloud-env` Secret. Check their presence. Use a private `credentials.env` with the required application keys (`ADMIN_INITIAL_PASSWORD`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_CONFIG_REPO_NAME`, `DD_API_KEY`, `DD_APP_KEY`). Put the production OAuth `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in a second ignored file, `oauth-prod.env`. The optional voice keys are `SCW_SECRET_KEY`, `REPORT_MODEL_API_KEY`, `VOICE_DEPLOYMENT_ANALYSIS_MODEL`, `SCW_DEFAULT_PROJECT_ID` and `VOICE_DEPLOYMENT_GATEWAY_BASE_URL`. Never commit these files.

From the portal repository after `npm ci`:

```sh
kubectl -n cnp-portal get serviceaccount cnp-portal
kubectl -n cnp-portal get configmap openbao-ca
kubectl -n cnp-portal get secret cnp-portal-cloud-env
node scripts/deploy/apply-app-secret.js /secure/path/credentials.env --oauth-file /secure/path/oauth-prod.env --oauth-callback-registered
```

The script allowlists application credentials. It generates a strong session key if needed and preserves an existing key. It obtains Argo CD's certificate from `argocd/argocd-secret` and overrides the legacy public-IP/insecure endpoint with verified `https://argocd-server.argocd.svc`; Argo credentials stay in the Terraform Secret. Re-run the script when Argo rotates its certificate, then restart the portal pod.

**Voice configuration:** the initial production Secret omitted the Scaleway keys and `VOICE_DEPLOYMENT_ANALYSIS_MODEL` even though the local `.env` contained them. This made the voice wizard report “Le nom du modèle d’analyse manque.” To enable or rotate only voice settings, run `node scripts/deploy/update-voice-secret.js /secure/path/private.env`. The script requires the two keys and model name, checks the GKE context, preserves every unrelated Secret key, restarts the portal and checks voice readiness. A later `apply-app-secret.js` run retains previously published voice keys when its input omits them. On 21 November a synthetic analysis from the pod succeeded and `/api/health` remained all `ok`. Keep the private file outside Git or ignored, mode `0600`. The model currently configured is `mistral-small-3.2-24b-instruct-2506`.

**OAuth registration gate:** the local `.env` used on 19 November has a localhost callback and an OAuth client from a different app. Before passing `--oauth-callback-registered`, open the production OAuth app under GitHub **Settings → Developer settings → OAuth apps**, add the exact production callback `https://portal.apps.mooroon5.fr/auth/github/callback`, and save. Keep its localhost callback if local development needs it. Put that same app's Client ID and a matching client secret in `oauth-prod.env`. Then complete a real browser sign-in; a redirect from `/auth/github` alone does not prove registration. If the app is owned by another account or organization, its owner must make this change.

To rotate just the OAuth client later, from the portal repository run:

```sh
node scripts/deploy/update-oauth-secret.js /secure/path/oauth-prod.env
```

This checks the client/secret pair and registered callback with GitHub before updating the Kubernetes Secret. It restarts the one portal pod and verifies the live redirect. The script replaces the Secret without a plaintext `kubectl.kubernetes.io/last-applied-configuration` annotation. Expect a brief interruption during the `Recreate` rollout.

## Build and promote an image

Start from the latest `main` in both the portal and config repositories so recent changes from other contributors, including AWS failover and Datadog, are included. The main-branch `CNP Portal release image` workflow builds and pushes to `europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal`. Wait for its lint, tests, secret scan, dependency and image checks. `.gitleaksignore` has narrow exceptions for known public Azure role UUIDs; review any new exception rather than disabling scanning. Resolve the new digest from Artifact Registry and pin **the same digest** in `k8s/overlays/prod/kustomization.yaml` and `k8s/provisioner/deployment.yaml`. Do not use a mutable tag in prod.

```sh
gcloud artifacts docker images describe europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal:<main-sha> --format='value(image_summary.digest)'
kubectl kustomize k8s/overlays/prod
kubectl apply --dry-run=server -k k8s/overlays/prod
kubectl -n argocd annotate application cnp-portal argocd.argoproj.io/refresh=hard --overwrite
kubectl -n argocd patch application cnp-portal --type merge -p '{"operation":{"sync":{"prune":false}}}'
kubectl -n cnp-portal rollout status deployment/cnp-portal --timeout=120s
kubectl -n cnp-portal rollout status deployment/openbao-runtime-provisioner --timeout=120s
```

Before sync, run `node scripts/deploy/backup-sqlite.js` and record its verified GCS object URI. Check that the rendered portal Deployment has `PORT=3000`, one replica, `Recreate`, and the intended digest; check that the provisioner has the same digest, projected token and read-only filesystem. Inspect the rendered `env` by **name**, never by array index: a positional patch previously overwrote the provisioner address and token path. The provisioner must start without importing the portal's SQLite database or mounting its PVC. Sync the reviewed revision manually, then wait for **both** rollouts and Argo CD `Synced/Healthy`. `Recreate` prevents concurrent SQLite writers.

The Azure platform ConfigMap in this overlay is generated from `cnp/azure`'s non-secret `terraform output -json portal_environment`; the Azure identity ConfigMap holds `terraform output -raw openbao_portal_client_id`. Re-export and review both values after an Azure infrastructure replacement before syncing the portal. The portal's projected Kubernetes token successfully exchanged for an Entra token on 20 November 2026. This proves portal federation, but each Azure application still needs its own runtime identity and Key Vault before deployment with variables.

The private endpoint and JWT audience are deployed. The four `PRIVATE_*` values match the private-cloud Terraform `portal_environment` output supplied on 20 November 2026. OpenBao private accepted a fictitious KV v2 write/read and version destruction from the portal pod. Verify an application deployment and its ExternalSecret on k3s before declaring end-to-end delivery ready.

The AWS OpenBao address, audience, role and mount come from `cnp/cluster/aws/19-openbao.tf`; the account and region are `626278345026/eu-west-3`. The portal uses its projected GKE token and federated AWS role for failover, not static credentials. AWS failover has been exercised through the portal; preserve that path when changing the GCP or Azure provisioner. Check the dedicated application roles and Secrets Manager delivery for each new failover deployment.

## Incidents to prevent on the next deployment

| Symptom | Cause and repeatable check |
| --- | --- |
| GitHub says `redirect_uri is not associated` | The production callback must be registered on the **same OAuth app** as the deployed Client ID: `https://portal.apps.mooroon5.fr/auth/github/callback`. Verify a browser round trip after secret rotation. |
| Variable deployment says dedicated GCP/Azure identity missing | The per-application identity, scope and secret delivery must be provisioned and verified before publishing. The dedicated provisioner is part of the production overlay. Do not replace the check with a guessed identity name or a broad shared principal. |
| An existing GitOps environment blocks deployment | `apps/<app>/crossplane/<env>` may belong to an earlier deployment. Inspect its owner and live resources before adoption. For a confirmed disposable test, request deletion through the portal and wait for completion before retrying. Never erase an owned application to clear this guard. |
| Voice wizard says analysis model missing | Publish the five allowlisted voice settings with `update-voice-secret.js`, then verify `voice-deployment.configured()` and a synthetic model call from the pod. |
| Portal or provisioner fails after image promotion | Verify the same immutable digest in both manifests, `kubectl kustomize`, server-side dry run, both rollouts, and Argo CD. Keep the provisioner separate from SQLite and avoid positional `env` patches. |
| Failover application deletion takes time | Inventory the exact app and owner **before** confirming deletion. The portal's asynchronous teardown can wait for cloud resources. Watch its state until `completed`; do not remove cloud resources directly or claim completion while it is running. |

If the platform Terraform must be reapplied, the actual GCP state bucket is `cnp-tfstate-512313`; the legacy provider file still mentions `cnp-tfstate-508716`. Initialize explicitly with `terraform init -backend-config=bucket=cnp-tfstate-512313`, use approved credentials and review the plan before apply. Avoid carrying this discrepancy into an unreviewed full apply.

## Verify the release

```sh
kubectl -n argocd get application cnp-portal
kubectl -n cnp-portal get pod,pvc,certificate,ingress
kubectl -n cnp-portal get deployment cnp-portal openbao-runtime-provisioner
curl --fail https://portal.apps.mooroon5.fr/healthz
curl --fail https://portal.apps.mooroon5.fr/ready
curl --fail https://portal.apps.mooroon5.fr/api/health
```

`/api/health` must report `ok` for GitHub, Argo CD, Datadog, Kubernetes and Crossplane. Log in with the administrator account, then test the Datadog logs/metrics views and the Argo CD view. **Complete a real GitHub OAuth login**; `/api/health` checks the separate GitHub App API and does not check the OAuth callback registration. Confirm voice status and a synthetic analysis if voice settings changed. Confirm both Deployments `1/1`. For a deployment-path change, submit a disposable application through the **portal UI/API**, wait for its pipeline and runtime, then delete it through the portal and verify teardown. A direct cloud deployment does not exercise this workflow. Check only the affected cloud modes plus the shared health and failover gates; no runbook can guarantee zero errors.

## Back up and restore

Create the backup bucket once, then enable object versioning:

```sh
gcloud storage buckets create gs://cnp-portal-backup-512313 --project=cnp-terraform-512313 --location=europe-west9 --uniform-bucket-level-access
gcloud storage buckets update gs://cnp-portal-backup-512313 --versioning
```

Run before each promotion and regularly afterward:

```sh
node scripts/deploy/backup-sqlite.js
```

The script takes an online SQLite backup from the running pod, uploads it to GCS, downloads the uploaded object to a private temporary directory, checks SQLite integrity and the users table, and removes temporary copies. Record the printed object URI in the release record. On 19 November 2026, `gs://cnp-portal-backup-512313/sqlite/20261119T185457Z.sqlite` passed this test.

For disaster recovery, first make another backup if the old pod can run. Scale the portal to zero and wait until no pod mounts `cnp-portal-data`. Download the selected object and check it with `better-sqlite3` before replacing the PVC file. Mount the PVC in a temporary pod using the same portal image and UID 1000; move the old `.sqlite`, `-wal` and `-shm` files to a dated recovery directory, copy the verified backup to `/app/data/cnp-portal.sqlite`, then remove the temporary pod. Scale to one and verify login and user/deployment counts. Do not restore over a running SQLite writer. Restore the old files if verification fails.

## Rollback

Pin the previous known-good image digest in the prod overlay through a PR, then sync `cnp-portal` manually. Back up the SQLite database first. The PVC has `argocd.argoproj.io/sync-options: Delete=false`; do not prune it. A schema-changing release needs a compatible database restore plan. Verify HTTPS, login and `/api/health` again after rollback.
