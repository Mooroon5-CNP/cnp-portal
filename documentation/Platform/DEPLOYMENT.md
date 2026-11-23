# CNP Portal on GKE — deployment runbook

## Current release (snapshot from 21 November 2026; recheck before use)

- Project: `cnp-terraform-512313`; cluster: `cnp-cluster-terraform` in `europe-west9-b`.
- Portal source: `Mooroon5-CNP/cnp-portal`, branch `main`, overlay `k8s/overlays/prod`.
- GitOps source: `Mooroon5-CNP/config-repo`, branch `main`, applications `cert-manager`, `cnp-portal-bootstrap`, `cnp-portal`.
- URL: `https://portal.apps.mooroon5.fr` via ingress-nginx `34.163.88.46`.
- One pod, SQLite on `cnp-portal-data` (10 Gi `standard-rwo`, PV reclaim policy `Delete`). Rollouts start the new pod before stopping the old one (`RollingUpdate`, `maxSurge: 1`, `maxUnavailable: 0`); a required pod affinity keeps the surge pod on the node that already has the ReadWriteOnce disk attached, and both processes share the WAL-mode database for the few seconds of overlap. Sessions are in memory, so a rollout still signs everyone out. Do not increase replicas without migrating the database and session store.
- MCP UI and code remain present. The real MCP-CNP service is a later promotion; the current client uses test data.
- Both the portal and the dedicated OpenBao runtime provisioner currently use image `sha256:6769759244337d47ed4ba2fdde1adc69a94fdf70bd2d371e7f633e190c32edd9`. On 21 November both Deployments were `1/1`, Argo CD reported `Synced/Healthy` for the portal and Dancing Duck prod, and `/api/health` returned `ok` for GitHub, Argo CD, Datadog, Kubernetes and Crossplane. Recheck these facts before each release; they are a dated observation, not a permanent guarantee.
- [OpenBao](OPENBAO.md) documents the variable paths; endpoint health does not prove application-level delivery.
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

The script **updates only keys explicitly supplied** and preserves all other keys already present in `cnp-portal-app-env`, including voice, future integrations, optional settings and the session key. It generates a strong session key only if none exists. It obtains Argo CD's certificate from `argocd/argocd-secret` and overrides the legacy public-IP/insecure endpoint with verified `https://argocd-server.argocd.svc`; Argo credentials stay in the Terraform Secret. Re-run the script when Argo rotates its certificate, then restart the portal pod. The scripts for voice and OAuth also merge their targeted keys into the existing Secret. **Never delete and recreate this Secret or use an `apply` manifest containing only a subset of its keys**: that would erase the others. `cnp-portal-cloud-env` is a separate Terraform-managed Secret; these scripts do not modify it.

Before and after a credential change, compare **key names only**, never values:

```sh
kubectl -n cnp-portal get secret cnp-portal-app-env -o json | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => console.log(Object.keys(JSON.parse(s).data).sort().join("\n")))'
```

Retain the first list with the release record and confirm that no unrelated key disappeared. Keep the private source files outside Git or ignored with mode `0600`.

**Voice configuration:** the initial production Secret omitted the Scaleway keys and `VOICE_DEPLOYMENT_ANALYSIS_MODEL` even though the local `.env` contained them. This made the voice wizard report “Le nom du modèle d’analyse manque.” To enable or rotate only voice settings, run `node scripts/deploy/update-voice-secret.js /secure/path/private.env`. The script requires the two keys and model name, checks the GKE context, preserves every unrelated Secret key, restarts the portal and checks voice readiness. A later `apply-app-secret.js` run retains previously published voice keys when its input omits them. On 21 November a synthetic analysis from the pod succeeded and `/api/health` remained all `ok`. Keep the private file outside Git or ignored, mode `0600`. The model currently configured is `mistral-small-3.2-24b-instruct-2506`.

**OAuth registration gate:** the local `.env` used on 19 November has a localhost callback and an OAuth client from a different app. Before passing `--oauth-callback-registered`, open the production OAuth app under GitHub **Settings → Developer settings → OAuth apps**, add the exact production callback `https://portal.apps.mooroon5.fr/auth/github/callback`, and save. Keep its localhost callback if local development needs it. Put that same app's Client ID and a matching client secret in `oauth-prod.env`. Then complete a real browser sign-in; a redirect from `/auth/github` alone does not prove registration. If the app is owned by another account or organization, its owner must make this change.

### Secret inventory and recovery rule

`apply-app-secret.js` preserves keys only while `cnp-portal-app-env` still
exists. It cannot recover a deleted Secret. Before a cluster rebuild, back up
the Secret through the organization's approved encrypted secret store. Never
put a plaintext export in Git, a ticket, a release artifact or this runbook.
Restrict and test access to that encrypted backup separately.

| Secret or credential source | Key names / recovery owner |
|---|---|
| `cnp-portal-app-env` | `ADMIN_INITIAL_PASSWORD`, `SESSION_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_CONFIG_REPO_NAME`, optional `GITHUB_CONFIG_REPO_TOKEN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI`, `DD_API_KEY`, `DD_APP_KEY`, optional `DD_SITE`, `SCW_SECRET_KEY`, `REPORT_MODEL_API_KEY`, `SCW_DEFAULT_PROJECT_ID`, `VOICE_DEPLOYMENT_ANALYSIS_MODEL`, optional `VOICE_DEPLOYMENT_GATEWAY_BASE_URL`, `ARGOCD_SERVER_URL`, `ARGOCD_INSECURE`, `ARGOCD_CA_CERT_BASE64`. Owners: portal/GitHub admins, Datadog admins, Scaleway admins, Argo CD bootstrap. |
| `cnp-portal-cloud-env` | Terraform-managed platform settings. Owner: Terraform state and approved cloud operator. Recreate from current reviewed outputs and inputs. |
| `argocd/argocd-secret` | Argo CD internal credentials and TLS material. Recreate through reviewed Argo CD bootstrap. |
| External provider access | GitHub App, OAuth, Datadog, Scaleway, cloud federation/IAM, DNS and Terraform backend access. Recover from each provider's approved secret manager/account owner. |

Names above are the current inventory, not a promise that every key is
required. Add new integration keys and their owners when introducing them. A
rebuild is not ready if any required credential lacks a tested recovery source.
Keep the first key-name list in the release record and compare after restore;
never print values:

```sh
kubectl -n cnp-portal get secret cnp-portal-app-env -o json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(Object.keys(JSON.parse(s).data).sort().join("\n")))'
kubectl -n cnp-portal get secret cnp-portal-cloud-env -o json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(Object.keys(JSON.parse(s).data).sort().join("\n")))'
```

To rotate just the OAuth client later, from the portal repository run:

```sh
node scripts/deploy/update-oauth-secret.js /secure/path/oauth-prod.env
```

This checks the client/secret pair and registered callback with GitHub before updating the Kubernetes Secret. It restarts the one portal pod and verifies the live redirect. The script replaces the Secret without a plaintext `kubectl.kubernetes.io/last-applied-configuration` annotation. The old pod keeps serving until the new one is ready; users are signed out because sessions are in memory.

## Build and promote an image

### Routine image redeploy

This path assumes the cluster, Secrets and PVC still exist. Record current
digests, Secret key names, PVC status, Argo revision and health. Verify a fresh
SQLite backup before changing the image and retain the previous digest for
rollback. Do not delete/recreate Secrets, PVCs, namespace, certificates,
ingress, Argo CD, Crossplane providers or cloud resources. Keep the manual Argo
sync with `prune:false`. Do not run `kubectl delete`, apply a partial Secret,
`terraform destroy` or a broad Terraform apply as part of image promotion.

Start from the latest `main` in both the portal and config repositories so recent changes from other contributors, including AWS failover and Datadog, are included. The main-branch `CNP Portal release image` workflow builds and pushes to `europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal`. Wait for its lint, tests, secret scan, dependency and image checks. `.gitleaksignore` has narrow exceptions for known public Azure role UUIDs; review any new exception rather than disabling scanning. Resolve the new digest from Artifact Registry and pin **the same digest** in `k8s/overlays/prod/kustomization.yaml` and `k8s/provisioner/deployment.yaml`. Do not use a mutable tag in prod.

**Why the digest change is merged into `main`.** The Argo CD Application
`cnp-portal` follows `main:k8s/overlays/prod` with manual sync. Argo deploys
what `main` describes, so the digest bump must be committed to `main` before
the sync. Make it on a `deploy/image-<short-digest>` branch, review, then merge
into `main`. Merging alone deploys nothing; the rollout starts only at the
manual sync. Never sync another revision or run `kubectl set image`: the live
cluster would drift from `main`, and the next sync from `main` would silently
roll back. Every deploy is therefore one commit, and a rollback is a revert of
that commit followed by a sync.

```sh
gcloud artifacts docker images describe europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal:<main-sha> --format='value(image_summary.digest)'
kubectl kustomize k8s/overlays/prod
kubectl apply --dry-run=server -k k8s/overlays/prod
kubectl -n argocd annotate application cnp-portal argocd.argoproj.io/refresh=hard --overwrite
kubectl -n argocd patch application cnp-portal --type merge -p '{"operation":{"sync":{"prune":false}}}'
# Argo applies the sync a few seconds later: wait for the new digest before rollout status,
# otherwise rollout status can report the previous, already finished rollout.
until kubectl -n cnp-portal get deployment cnp-portal -o jsonpath='{.spec.template.spec.containers[0].image}' | grep -q '<new-digest>'; do sleep 3; done
kubectl -n cnp-portal rollout status deployment/cnp-portal --timeout=180s
kubectl -n cnp-portal rollout status deployment/openbao-runtime-provisioner --timeout=180s
```

Before sync, run `node scripts/deploy/backup-sqlite.js` and record its verified GCS object URI. Check that the rendered portal Deployment has `PORT=3000`, one replica, `RollingUpdate` with `maxUnavailable: 0` and the same-node pod affinity, and the intended digest; check that the provisioner has the same digest, projected token and read-only filesystem. Inspect the rendered `env` by **name**, never by array index: a positional patch previously overwrote the provisioner address and token path. The provisioner must start without importing the portal's SQLite database or mounting its PVC. Sync the reviewed revision manually, then wait for **both** rollouts and Argo CD `Synced/Healthy`. During the short overlap two processes share the SQLite file on one node; WAL locking makes that safe, but the new pod marks `running` failover operations as failed on start, so first check that `failover_operations` has no `running` row, no `failover_provisioning` lease is held and no environment deletion is in progress. If the surge pod cannot start, the old pod keeps serving: revert the digest commit and sync again.

Pre-sync overlap check (read-only; all three counts must be `0`):

```sh
kubectl -n cnp-portal exec deploy/cnp-portal -- node -e "
const d=new (require('better-sqlite3'))(process.env.DB_PATH,{readonly:true});
console.log('running failover operations', d.prepare(\"select count(*) n from failover_operations where state='running'\").get().n);
console.log('held failover leases', d.prepare('select count(*) n from failover_provisioning where lease_until > '+Date.now()).get().n);
console.log('deletions in progress', d.prepare(\"select count(*) n from environment_deletions where state not in ('completed','failed')\").get().n);"
```

After the sync, check: both pods `1/1` on the new digest with no restarts,
`/healthz` and `/ready` return 200 on `https://portal.apps.mooroon5.fr`,
Argo `Synced/Healthy` at the merge commit, and that Secret key names and the
PVC volume are unchanged from the values recorded before the sync. In
addition to the SQLite backup, take a disk snapshot of the PVC's GCE disk
(`gcloud compute disks snapshot <pv-disk> --zone europe-west9-b`); the PV
reclaim policy is `Delete`.

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
| Fresh GCP service account is created but IAM/Cloud Run rejects it | IAM propagation is asynchronous. Keep the provisioner's visibility wait and retry; do not add a shared runtime principal or skip its scoped permission check. |
| GCP variable version is rejected as malformed | A Google Secret Manager version resource includes the numeric project identifier. Keep the GCP delivery parser and its regression test when changing version references. |
| AWS role creation fails on `GetRole` | The failover identity code creates the dedicated ECS role without requiring a preliminary `GetRole`. Review the create/verify permissions before changing its bootstrap sequence. |
| Failover engine cannot call Kubernetes | The portal's production pod needs its projected Kubernetes service-account token; the base manifest disables automatic mounting. Verify the `kube-api-access` volume and mount after rendering the overlay. |
| `cnp-failover-platform` appears missing | Kustomize adds a content hash to the generated ConfigMap name. Read the `failover-platform` volume's actual `configMap.name` from the Deployment and verify that resource; do not create a second un-hashed ConfigMap. |
| Failback opens DNS before GCP is closed | The failback engine must close GCP traffic itself before reopening the DNS route. Retain the failback regression test and inspect the route state in a failback exercise. |
| Datadog integration flags an expected HTTP 501 as an error | The private k3s observability path excludes this expected response from error counting. Check actual logs and metrics in the portal after a release, beyond `/api/health`. |
| A credential refresh removes another feature's key | All three targeted Secret scripts preserve existing `cnp-portal-app-env` keys. Compare key names before/after; run the Secret preservation regression test. Never replace the Secret with a partial manifest. |
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

| Service | Post-release evidence |
| --- | --- |
| Public portal, TLS and SQLite | HTTPS responds; certificate is ready; portal pod and PVC are healthy; login and existing deployment list load. |
| GitHub | `/api/health` reports the GitHub App `ok`; a **browser OAuth round trip** reaches the portal with the registered production callback. |
| Argo CD and Crossplane | `/api/health` reports both `ok`; portal application is `Synced/Healthy`; inspect an existing application's Argo view. |
| Datadog | `/api/health` reports `ok`; open a real application's logs and metrics in the portal. |
| Voice | Readiness returns true and a synthetic model analysis succeeds; transcription still needs a real WAV test if that code or credentials changed. |
| OpenBao and runtime provisioner | Both Deployments are ready; for a changed cloud mode, let the portal create a disposable application with variables and verify scoped delivery and teardown. Do not infer this from JWT login alone. |
| AWS failover and failback | For changes to this path, exercise promotion and return through the portal and check the DNS route; do not infer success from a healthy GCP pod. |
| MCP | Portal UI/code remain present; the real remote MCP-CNP service is a later release, so mark it unavailable rather than treating test data as a live service. |

For a read-only OpenBao availability check from the portal pod, query
`/v1/sys/health?standbyok=true` with the configured TLS trust. The bare GCP
health endpoint returned HTTP 429 once while the `standbyok=true` check
returned HTTP 200, `initialized=true`, `sealed=false` on 21 November. A
standby response alone is not proof of an outage. TLS availability is not a
substitute for JWT authorization or a real application variable test.

### Copyable checks and resource names

Run these from a machine with the approved GKE context. They read state only;
they do not create an application or print Secret values.

| Resource | Name or endpoint |
| --- | --- |
| GKE context | `gke_cnp-terraform-512313_europe-west9-b_cnp-cluster-terraform` |
| Namespace | `cnp-portal` |
| Portal and provisioner Deployments | `cnp-portal`, `openbao-runtime-provisioner` |
| Portal SQLite PVC | `cnp-portal-data` |
| Portal TLS Certificate and Ingress | `cnp-portal-tls`, `cnp-portal` |
| Portal application Secret / Terraform cloud Secret | `cnp-portal-app-env` / `cnp-portal-cloud-env` |
| Public portal | `https://portal.apps.mooroon5.fr` |
| Argo CD application | `argocd/cnp-portal` |
| OpenBao CA ConfigMap | `cnp-portal/openbao-ca` |
| Failover configuration ConfigMap | `cnp-portal/cnp-failover-platform-<Kustomize hash>`; read the actual name from the Deployment volume |

```sh
kubectl config current-context
kubectl -n cnp-portal get deployment cnp-portal openbao-runtime-provisioner
kubectl -n cnp-portal get pod,pvc,certificate,ingress
kubectl -n cnp-portal get secret cnp-portal-app-env cnp-portal-cloud-env
kubectl -n cnp-portal get configmap openbao-ca
kubectl -n cnp-portal get deployment cnp-portal -o json | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).spec.template.spec.volumes.find(v=>v.name==="failover-platform").configMap.name))'
kubectl -n cnp-portal get configmap -o name | rg '^configmap/cnp-failover-platform-'
kubectl -n argocd get application cnp-portal
kubectl get providers.pkg.crossplane.io
curl -fsS https://portal.apps.mooroon5.fr/healthz
curl -fsS https://portal.apps.mooroon5.fr/ready
curl -fsS https://portal.apps.mooroon5.fr/api/health
```

Both Deployments should be `1/1`; the PVC `Bound`; the Certificate `Ready=True`;
Argo CD `Synced/Healthy`; and the five `/api/health` integrations `ok`.
`kubectl get providers.pkg.crossplane.io` shows each installed provider's
`Healthy` condition. For the production example application retained on 21
November, run `kubectl -n argocd get application app-2-dancingduck-prod`.

Check the exact OAuth redirect without exposing the Client ID:

```sh
node -e 'fetch("https://portal.apps.mooroon5.fr/auth/github",{redirect:"manual"}).then(r=>{const u=new URL(r.headers.get("location"));const ok=r.status===302&&u.hostname==="github.com"&&u.searchParams.get("redirect_uri")==="https://portal.apps.mooroon5.fr/auth/github/callback"&&!!u.searchParams.get("client_id");console.log({oauthRedirect:ok});process.exitCode=ok?0:1})'
```

This checks the outgoing URL. A human must still complete a browser login to
prove GitHub accepts the callback and the portal session works.

Check the provisioner and voice readiness from their pods:

```sh
kubectl -n cnp-portal exec deploy/openbao-runtime-provisioner -- node -e 'fetch("http://127.0.0.1:3001/healthz").then(r=>{console.log({provisioner:r.status});process.exitCode=r.ok?0:1})'
kubectl -n cnp-portal exec deploy/cnp-portal -- node -e 'const ok=require("./src/services/voice-deployment").configured();console.log({voiceConfigured:ok});process.exitCode=ok?0:1'
```

For OpenBao, the portal pod uses `CNP_OPENBAO_GCP_ADDR`,
`CNP_OPENBAO_AZURE_ADDR`, `CNP_OPENBAO_AWS_ADDR` and
`CNP_OPENBAO_PRIVATE_ADDR`. Query the four TLS endpoints from the pod using
the GCP CA file `/etc/openbao-ca/ca.crt`; HTTP 200 with `standbyok=true`
means the server is available, not that application permissions work. The
21 November read-only results were GCP, Azure, AWS and private all 200.

```sh
kubectl -n cnp-portal exec deploy/cnp-portal -- node -e '
const https = require("https"), fs = require("fs");
const targets = [["GCP","CNP_OPENBAO_GCP_ADDR"],["Azure","CNP_OPENBAO_AZURE_ADDR"],["AWS","CNP_OPENBAO_AWS_ADDR"],["Private","CNP_OPENBAO_PRIVATE_ADDR"]];
Promise.all(targets.map(([name,key]) => new Promise(resolve => {
  const addr = process.env[key];
  if (!addr) return resolve({name,error:"address missing"});
  const options = {timeout:7000};
  if (name === "GCP") options.ca = fs.readFileSync("/etc/openbao-ca/ca.crt");
  const req = https.get(addr.replace(/\/$/,"") + "/v1/sys/health?standbyok=true", options, res => {
    res.resume(); resolve({name,status:res.statusCode});
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", e => resolve({name,error:e.code || e.message}));
}))).then(rows => {
  console.log(JSON.stringify(rows));
  process.exitCode = rows.every(row => row.status === 200) ? 0 : 1;
});'
```

When changing a deployment mode, use the **portal** to create a disposable
`<app>/<env>`, then follow its pipeline, Argo CD application, runtime and
variable delivery. Record the exact app name, environment, owner and GitOps
path `config-repo/apps/<app>/crossplane/<env>` before testing deletion. The
portal's deletion status must reach `completed`; verify the GitOps path and
Argo CD application disappeared. Do not substitute direct cloud commands or
delete an application owned by someone else.

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

### Full recovery or new-cluster rebuild

Use this path only after cluster/PVC loss or an intentional new project/region.
First complete the Secret inventory and confirm recoverable Terraform state,
provider credentials and a verified SQLite backup. Otherwise recovery is
blocked: do not claim the services or credentials can be recreated.

1. Record current portal/provisioner image digests, Git revisions, Terraform
   backend/workspace, project/region/zone, DNS, Argo revisions, Secret key names,
   backup URI and service owners. Freeze deployments and deletions.
2. Restore from the existing reviewed Terraform states and correct workspace.
   Current GCP backend bucket: `cnp-tfstate-512313`; the legacy provider file
   mentions `cnp-tfstate-508716`, so use the explicit backend override above.
   Authenticate as the approved operator, review a saved plan and never create
   an empty replacement state or run `destroy` for recovery.
3. Restore network, GKE, IAM/workload identity, registry access, Crossplane
   providers, DNS, storage and cloud integrations in dependency order. Apply
   current `config-repo/main` bootstrap manifests using “Recreate the platform
   bootstrap”; verify cert-manager, issuer, Argo CD, providers, ingress and DNS.
4. Restore `cnp-portal-data` from a selected SQLite backup and verify integrity
   before starting the portal. Recreate `cnp-portal-cloud-env` from current
   reviewed Terraform outputs. Restore `cnp-portal-app-env` from the approved
   encrypted secret store with the scripts above; restore external credentials
   from their source owners. Compare key names. Do not print or commit values.
5. Pin reviewed immutable portal and provisioner digests. Keep one portal
   replica, `RollingUpdate` with same-node affinity, PVC retention `Delete=false`, projected tokens and the
   provisioner read-only filesystem. Render Kustomize and server-dry-run before
   manual Argo sync.
6. Before restoring public traffic, verify both deployments, PVC `Bound`, TLS,
   DNS, Argo `Synced/Healthy`, `/healthz`, `/ready`, `/api/health`, OAuth browser
   login, Datadog/Argo views, voice, provisioner health and all four OpenBao
   endpoints. Run portal-driven disposable app tests for every mode claimed
   restored, including variable delivery, isolation and deletion. Test failover
   and failback only through the portal workflow.

This process protects data only when backups, Terraform state and provider
credentials remain available. It cannot recreate secrets with lost source
credentials. Mark a service unavailable until its checks pass.

## Rollback

Pin the previous known-good image digest in the prod overlay through a PR, then sync `cnp-portal` manually. Back up the SQLite database first. The PVC has `argocd.argoproj.io/sync-options: Delete=false`; do not prune it. A schema-changing release needs a compatible database restore plan. Verify HTTPS, login and `/api/health` again after rollback.
