# CNP Portal on GKE — deployment runbook

## Current release (19 November 2026)

- Project: `cnp-terraform-512313`; cluster: `cnp-cluster-terraform` in `europe-west9-b`.
- Portal source: `Mooroon5-CNP/cnp-portal`, branch `main`, overlay `k8s/overlays/prod`.
- GitOps source: `Mooroon5-CNP/config-repo`, branch `main`, applications `cert-manager`, `cnp-portal-bootstrap`, `cnp-portal`.
- URL: `https://portal.apps.mooroon5.fr` via ingress-nginx `34.163.88.46`.
- One pod, `Recreate` rollout, SQLite on `cnp-portal-data` (10 Gi `standard-rwo`). A rollout interrupts active sessions. Do not increase replicas without migrating the database and session store.
- MCP UI and code remain present. The real MCP-CNP service is a later promotion; the current client uses test data.
- GCP OpenBao is configured and the portal JWT login has been verified. Azure, AWS and private OpenBao routing and their runtime identities require separate live verification before variable deployment in those modes.

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

Terraform supplies the `cnp-portal` Kubernetes service account, GCP OpenBao CA ConfigMap, and `cnp-portal-cloud-env` Secret. Check their presence. Use a private `credentials.env` with the required application keys (`ADMIN_INITIAL_PASSWORD`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_CONFIG_REPO_NAME`, `DD_API_KEY`, `DD_APP_KEY`); optional OAuth and Datadog site keys may be present. Never commit this file.

From the portal repository after `npm ci`:

```sh
kubectl -n cnp-portal get serviceaccount cnp-portal
kubectl -n cnp-portal get configmap openbao-ca
kubectl -n cnp-portal get secret cnp-portal-cloud-env
node scripts/deploy/apply-app-secret.js /secure/path/credentials.env
```

The script allowlists application credentials. It generates a strong session key if needed and preserves an existing key. It obtains Argo CD's certificate from `argocd/argocd-secret` and overrides the legacy public-IP/insecure endpoint with verified `https://argocd-server.argocd.svc`; Argo credentials stay in the Terraform Secret. Re-run the script when Argo rotates its certificate, then restart the portal pod. The OAuth redirect is set to `https://portal.apps.mooroon5.fr/auth/github/callback`; the GitHub OAuth application must register that callback.

## Build and promote an image

The main-branch `CNP Portal release image` workflow builds and pushes to `europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal`. Resolve its digest from Artifact Registry, review a PR pinning that digest in `k8s/overlays/prod/kustomization.yaml`, and merge it to `main` after CI. Do not use a mutable tag in prod.

```sh
gcloud artifacts docker images describe europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal:<main-sha> --format='value(image_summary.digest)'
kubectl kustomize k8s/overlays/prod
kubectl -n argocd annotate application cnp-portal argocd.argoproj.io/refresh=hard --overwrite
kubectl -n argocd patch application cnp-portal --type merge -p '{"operation":{"sync":{"prune":false}}}'
kubectl -n cnp-portal rollout status deployment/cnp-portal --timeout=120s
```

Check that the rendered Deployment has `PORT=3000`, one replica and the intended digest before syncing. `Recreate` prevents concurrent SQLite writers.

## Verify the release

```sh
kubectl -n argocd get application cnp-portal
kubectl -n cnp-portal get pod,pvc,certificate,ingress
curl --fail https://portal.apps.mooroon5.fr/healthz
curl --fail https://portal.apps.mooroon5.fr/ready
curl --fail https://portal.apps.mooroon5.fr/api/health
```

`/api/health` must report `ok` for GitHub, Argo CD, Datadog, Kubernetes and Crossplane. Log in with the administrator account, then test the Datadog logs/metrics views and the Argo CD view. Test a real GitHub OAuth login after updating the registered callback. GCP OpenBao's JWT login was verified from the portal pod; a complete variable write/read/isolation/rotation exercise remains a separate acceptance test. Do not claim Azure, AWS, private cloud or failover variable delivery until those instances and runtime identities pass the same live tests.

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
