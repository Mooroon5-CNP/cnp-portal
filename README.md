# CNP Portal — Internal Developer Platform

A web portal that lets developers deploy GitHub-hosted Node.js apps to a GCP Kubernetes cluster via GitOps (ArgoCD + Kustomize). The portal manages the full lifecycle: onboarding, CI wiring, ArgoCD ApplicationSet provisioning, and offboarding.

---

## What it does

A user submits a GitHub repo URL through the UI. The portal then automatically:

1. Writes Kubernetes manifests for the app into [config-repo](https://github.com/Mooroon5-CNP/config-repo) (base + dev/prod overlays)
2. Registers the app in `config-repo/apps/registry.yaml`
3. Creates `argocd/overlays/{app}/kustomization.yaml` in config-repo
4. Applies ArgoCD `ApplicationSet` objects directly to the cluster (so ArgoCD starts watching the app)
5. Commits `.github/workflows/ci.yml` to the app repo, wiring it to the reusable pipeline in [ci-templates](https://github.com/Mooroon5-CNP/ci-templates)
6. Injects `CONFIG_REPO_TOKEN` as a GitHub Actions secret in the app repo
7. Creates the `prod` branch in the app repo
8. Commits a trigger file (`.cnp-platform`) to fire the first CI run

If **DB persistante** is checked at onboarding, the portal also writes a `pvc.yaml` (1Gi ReadWriteOnce) into each overlay and mounts it at `/data` inside the container. The volume survives pod restarts.

When an app is deleted, the portal:
1. Removes all config-repo files (manifests, overlays, crossplane dir, argocd overlay)
2. Calls the **ArgoCD REST API** with `cascade=true` to delete each ArgoCD `Application` — this prunes all managed Kubernetes resources (including Crossplane CRs), which triggers Crossplane to delete the actual GCP resources (Cloud Run service, GCS bucket if present)
3. Deletes ArgoCD `ApplicationSet` objects via the ArgoCD REST API
4. Deletes the Kubernetes namespaces (`{app}-dev`, `{app}-prod`) — requires the namespace ClusterRole below

A re-onboard of the same app starts from a clean state.

After that the CI pipeline is self-contained: on each push to `main` it builds the image, pushes to GCP Artifact Registry, updates `newTag` in config-repo, and ArgoCD syncs automatically.

The app becomes accessible at `https://{appName}-dev.{CLUSTER_INGRESS_IP}.nip.io` — the portal detects the ingress controller IP automatically from the cluster.

---

## Stack

- **Runtime**: Node.js 20, Express, EJS templates (SSR)
- **Auth**: Local password + GitHub OAuth, session-based
- **Database**: SQLite via `better-sqlite3` at `data/cnp-portal.sqlite`
- **External integrations**: GitHub App (app-repo operations), GitHub PAT (config-repo writes), ArgoCD API, Kubernetes API (`@kubernetes/client-node`), Datadog API
- **Port**: 3000 (default)

---

## File map

```
src/
├── index.js                    Entry point — Express setup, route mounting, health endpoints (/healthz /ready)
├── config/
│   └── env.js                  All env-var validation and the config object; run directly to check missing vars
├── models/
│   ├── db.js                   SQLite init, schema migrations, default admin seed (admin/admin)
│   ├── user.js                 User CRUD (SQLite)
│   ├── deployment.js           Deployment records + team-access junction table
│   ├── deletion_request.js     Pending deletion requests (dev/devops → manager approval)
│   ├── argocd_access_request.js ArgoCD access requests (dev/devops → manager approval → auto-provisioning)
│   └── tokenStore.js           OAuth state token storage
├── middleware/
│   ├── auth.js                 populateUser (session → req.user), requireAuth, requirePending
│   ├── rbac.js                 PERMISSIONS map + can() / requirePermission() / requireRole()
│   └── logger.js               Pino-based structured logger + request middleware
├── clients/
│   ├── github.js               GitHub App client — createOrUpdateFile, setRepoSecret, createBranch, getRef, getLatestRun, getRuns, getRunJobs
│   ├── argocd.js               ArgoCD REST client — listApplications, syncApplication
│   ├── kubernetes.js           k8s API client — pods, namespaces, events, quotas, Crossplane XRDs,
│   │                           applyApplicationSet, deleteApplicationSet,
│   │                           getIngressControllerIp, isCertManagerAvailable, getIngressUrl,
│   │                           provisionArgoCDLocalUser (patches argocd-cm + argocd-secret)
│   └── datadog.js              Datadog metrics/logs/alerts client
├── services/
│   ├── onboarding.js           ★ Core logic — all config-repo writes + ApplicationSet apply/delete + ingress heal
│   │                           Contains all tpl* template functions. tplOverlayIngress() auto-detects cluster IP.
│   ├── github.js               GitHub PAT helpers for config-repo reads/writes + CI run/job queries
│   ├── argocd.js               ArgoCD service layer (listApps, syncApp, requestAccess, approveAccess → auto-provisions ArgoCD local user)
│   ├── k8s.js                  K8s service layer (wraps kubernetes client for routes)
│   ├── teams.js                Team management (persists to SQLite)
│   ├── gitlab.js               Legacy GitLab client (not used in main flow)
│   └── datadog.js              Datadog service layer
├── routes/
│   ├── deployments.js          ★ Deployment CRUD — onboarding trigger, status polling, deletion workflow, team access
│   │                           Detail page auto-heals ingress hostname if still placeholder
│   ├── auth.js                 Login/logout, GitHub OAuth callback
│   ├── dashboard.js            Home page
│   ├── admin.js                User management (manager only)
│   ├── teams.js                Team management routes
│   ├── argocd.js               ArgoCD — app listing, sync, access-request workflow (request / approve / reject)
│   ├── k8s.js                  Pod/namespace/event views
│   ├── observability.js        Datadog metrics, logs, alerts
│   ├── profile.js              User profile
│   ├── health.js               /api/health JSON endpoint
│   └── documentation.js        In-app docs viewer
└── views/                      EJS templates (one per route, partials in views/partials/)
k8s/                            The portal's own Kubernetes manifests (base + dev/prod overlays)
data/                           SQLite database files (not committed)
docs/adr/                       Architecture Decision Records
```

---

## Key flow: deploying a new app

```
POST /deployments
  └─ routes/deployments.js
       └─ onboardingService.onboardApp()         ← services/onboarding.js
            ├─ writeConfigRepoFile() ×10         ← base manifests + overlays via githubService (PAT)
            ├─ updateRegistry()                  ← apps/registry.yaml
            ├─ writeConfigRepoFile()             ← argocd/overlays/{app}/kustomization.yaml
            ├─ k8sClient.applyApplicationSet()   ← dev + prod ApplicationSets applied to cluster
            ├─ githubClient.createOrUpdateFile() ← .github/workflows/ci.yml in app repo (GitHub App)
            ├─ githubClient.setRepoSecret()      ← CONFIG_REPO_TOKEN secret in app repo
            ├─ githubClient.createBranch()       ← prod branch in app repo
            └─ githubClient.createOrUpdateFile() ← .cnp-platform trigger commit → fires first CI run
```

After onboarding, CI takes over on every push to `main`:

```
push to main (app repo)
  └─ .github/workflows/ci.yml → ci-templates/pipeline.yml
       ├─ lint-eslint / lint-hadolint
       ├─ test
       ├─ scan-secrets (Gitleaks) / scan-deps (Trivy fs)
       ├─ build → push to europe-west9-docker.pkg.dev/cnp-terraform/cnp-registry/{app}:{sha}
       ├─ scan-image (Trivy image) — deletes image and fails if CRITICAL CVE
       └─ update-config-dev
            └─ sed newTag in config-repo apps/{app}/overlays/dev/kustomization.yaml
                 └─ ArgoCD detects change → syncs dev namespace automatically
                      └─ App accessible at https://{app}-dev.{INGRESS_IP}.nip.io
```

---

## Ingress URL — automatic detection

The portal queries the cluster at onboarding time to find the ingress controller's external IP:
- Looks for `ingress-nginx-controller` service in `ingress-nginx` namespace
- Falls back to label search (`app.kubernetes.io/component=controller`) if name differs
- Builds hostname: `{appName}-{env}.{IP}.nip.io`
- If cert-manager is absent (detected via cluster query), generates HTTP-only Ingress (no TLS block)
- If cert-manager is present, adds `cert-manager.io/cluster-issuer: letsencrypt-prod` and TLS

If an existing app's Ingress still uses the `cnp.example.com` placeholder, the portal **automatically rewrites it** the next time someone opens the deployment detail page (fire-and-forget, no user action needed).

---

## ArgoCD access workflow

Managers have ArgoCD access by default. DevOps and dev users must request it through the portal.

```
DevOps visits /argocd
  └─ clicks "Demander un accès" (fills in reason + optional app name)
       └─ request saved to SQLite (argocd_access_requests table)

Manager visits /argocd
  └─ sees all pending requests in an alert card
       └─ clicks "Approuver"
            └─ services/argocd.js → approveAccess()
                 ├─ generates ArgoCD username (sanitised portal username)
                 ├─ generates random 16-char password
                 ├─ bcrypt-hashes the password
                 ├─ patches argocd-cm  (accounts.<username>: login)        via k8s API
                 ├─ patches argocd-secret (accounts.<username>.password)   via k8s API
                 └─ saves credentials to SQLite

DevOps revisits /argocd
  └─ sees their credentials (username + cleartext password + ArgoCD URL)
  └─ sees the live list of ArgoCD applications they have access to
```

**Kubernetes RBAC requirement** — the portal's service account (`KUBE_TOKEN`) must be able to `get` and `patch` the following resources in the `argocd` namespace:

```yaml
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["argocd-cm"]
  verbs: ["get", "patch"]
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["argocd-secret"]
  verbs: ["get", "patch"]
```

If the RBAC permission is missing the provisioning step is logged as an error but the
request is still marked approved and the portal shows the generated credentials —
a manager can then create the ArgoCD account manually using those same credentials.

**ApplicationSet RBAC requirement** — for the portal to apply `ApplicationSet` objects during app onboarding (step 4 above), the service account also needs:

```yaml
# Role in the argocd namespace
- apiGroups: ["argoproj.io"]
  resources: ["applicationsets"]
  verbs: ["get", "list", "create", "update", "patch", "delete"]
```

Apply the Role + RoleBinding from bootstrap step 4 below. Without it, ApplicationSets are not applied and ArgoCD will never watch the app — CI runs will build the image but nothing will deploy. The portal logs a warning in that case but still completes onboarding.

---

## Roles and permissions

| Role | What they can do |
|---|---|
| `dev` | Deploy apps, view own pipelines and pods, request deletion |
| `devops` | Everything dev can + scale pods, approve user accounts, manage team access |
| `manager` | Everything devops can + delete apps, modify roles, configure platform |

The full permission map is in `src/middleware/rbac.js:PERMISSIONS`.

Default admin: username `admin`, password `admin`, role `manager`. Change the password in production.

---

## Environment variables

All read via `src/config/env.js`. Run `node src/config/env.js` to validate.

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_APP_ID` | ✅ | GitHub App ID — used for app-repo operations (ci.yml, secrets, branches) |
| `GITHUB_APP_PRIVATE_KEY` | ✅ | GitHub App private key (PEM; `\n`-escaped single-line is accepted) |
| `GITHUB_APP_INSTALLATION_ID` | ✅ | GitHub App installation ID on the org |
| `GITHUB_CONFIG_REPO_NAME` | ✅ | `owner/repo` of the GitOps config-repo (default: `Mooroon5-CNP/config-repo`) |
| `GITHUB_CONFIG_REPO_TOKEN` | ✅ | Fine-grained PAT with Contents:write on config-repo |
| `ARGOCD_SERVER_URL` | ✅ | ArgoCD API base URL |
| `ARGOCD_TOKEN` | ✅ | ArgoCD bearer token |
| `ARGOCD_INSECURE` | — | `true` to skip TLS verification |
| `KUBE_API_URL` | ✅ | GKE API server URL |
| `KUBE_TOKEN` | ✅ | Service account token with permissions to manage ApplicationSets in `argocd` namespace |
| `KUBE_CA_CERT` | ✅ | Base64-encoded cluster CA certificate |
| `KUBE_NAMESPACE_PREFIX` | — | Filter namespaces shown in the portal (optional) |
| `DD_API_KEY` | ✅ | Datadog API key |
| `DD_APP_KEY` | ✅ | Datadog application key |
| `DD_SITE` | — | Datadog site (default: `datadoghq.com`) |
| `CLUSTER_BASE_DOMAIN` | ⚠️ | Ingress base domain — **must be set when changing GCP account/cluster** (see below). Auto-detected via K8s API if absent but unreliable after restarts. |
| `SESSION_SECRET` | — | Express session secret |
| `DB_PATH` | — | SQLite file path (default: `data/cnp-portal.sqlite`) |
| `PORT` | — | HTTP port (default: 3000) |

Copy `.env.example` to `.env` to get started locally.

---

## Changing GCP account or cluster — what to update

When you create a new GKE cluster (new GCP project, new account, Terraform re-apply), several values change. Run these commands against the **new** cluster to retrieve them, then update `.env` and the portal's K8s ConfigMap/Deployment.

### 1. Find `CLUSTER_BASE_DOMAIN`

`CLUSTER_BASE_DOMAIN` is the nip.io domain derived from the ingress controller's external IP. It controls every app URL the portal generates.

```bash
# Get the LoadBalancer IP assigned to ingress-nginx
kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

# Expected output: 34.155.213.145  (example — yours will differ)
# → CLUSTER_BASE_DOMAIN=<IP>.nip.io
# Example: CLUSTER_BASE_DOMAIN=34.155.213.145.nip.io
```

> If ingress-nginx isn't installed yet, run cluster bootstrap step 2 first and wait ~2 minutes for GCP to assign the IP.

Once you have the value, update **three places**:

```bash
# 1. Local .env
echo "CLUSTER_BASE_DOMAIN=<IP>.nip.io" >> .env

# 2. Portal K8s deployment (so the running portal uses it without restart)
kubectl set env deployment/cnp-portal -n cnp-portal \
  CLUSTER_BASE_DOMAIN=<IP>.nip.io

# 3. k8s/base/deployment.yaml (committed value for future deploys)
#    Edit the CLUSTER_BASE_DOMAIN env entry in k8s/base/deployment.yaml
#    and commit the change.
```

### 2. Find `KUBE_API_URL`

```bash
kubectl cluster-info | grep "Kubernetes control plane"
# → https://34.163.86.239  (example)
# → KUBE_API_URL=https://<IP>
```

### 3. Find `KUBE_CA_CERT`

```bash
kubectl config view --raw -o jsonpath=\
'{.clusters[?(@.name=="<YOUR_CLUSTER_CONTEXT_NAME>")].cluster.certificate-authority-data}'
# → base64-encoded CA cert string
# → KUBE_CA_CERT=<value>
```

Or via gcloud:
```bash
gcloud container clusters describe <CLUSTER_NAME> \
  --region <REGION> --project <PROJECT_ID> \
  --format="value(masterAuth.clusterCaCertificate)"
```

### 4. Find `KUBE_TOKEN` (portal service account token)

```bash
# The SA token is stored in a Secret named cnp-portal-token
kubectl get secret cnp-portal-token -n cnp-portal \
  -o jsonpath='{.data.token}' | base64 -d
# → KUBE_TOKEN=<value>
```

### 5. Find `ARGOCD_SERVER_URL` and `ARGOCD_UI_URL`

ArgoCD is exposed via ingress at `argocd.<IP>.nip.io`:

```bash
IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "ARGOCD_SERVER_URL=http://argocd.${IP}.nip.io"
echo "ARGOCD_UI_URL=http://argocd.${IP}.nip.io"
```

### 6. Find GCP-specific vars (`GCP_PROJECT`, `GCP_IMAGE_REGISTRY`)

```bash
# Current project
gcloud config get-value project
# → GCP_PROJECT=cnp-terraform-500015

# Artifact Registry URL (pattern: <region>-docker.pkg.dev/<project>/<repo>)
gcloud artifacts repositories list --project=<PROJECT_ID>
# → GCP_IMAGE_REGISTRY=europe-west9-docker.pkg.dev/<PROJECT_ID>/cnp-registry
```

### 7. Update existing app ingress hosts in config-repo

After getting the new IP, every app already onboarded has stale ingress hosts pointing to the old IP. Fix them in one command:

```bash
OLD_IP="34.155.213.145"   # replace with old IP
NEW_IP="<NEW_IP>"

find config-repo/apps -name "ingress.yaml" | xargs \
  sed -i "s/${OLD_IP}/${NEW_IP}/g"

git -C config-repo add -A
git -C config-repo commit -m "chore: update ingress hosts to new cluster IP ${NEW_IP}"
git -C config-repo push origin main
```

ArgoCD will auto-sync and nginx will start routing on the new IP within ~1 minute.

---

## Cluster bootstrap (one-time per cluster)

These steps must be run once after a new GKE cluster is created. They are normally automated in Terraform via `local-exec`. Without them, no app can deploy or be accessed.

```bash
# 1. Create the ArgoCD AppProject (required by all ApplicationSets)
kubectl apply -f config-repo/argocd/projects/default-project.yaml

# 2. Install ingress-nginx (gives apps an external IP via GCP LoadBalancer)
kubectl apply -f config-repo/infra/ingress-nginx/application.yaml

# 3. Install Crossplane (required for GCP Cloud Run provisioning)
kubectl apply -f config-repo/infra/crossplane/application.yaml

# 4. Grant the portal's service account permissions to manage ApplicationSets
#    and delete Kubernetes namespaces (required for full app offboarding).
#    ArgoCD Application objects are deleted via the ArgoCD REST API (ARGOCD_TOKEN),
#    so no K8s RBAC is needed for those.
kubectl apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cnp-portal-applicationsets
  namespace: argocd
rules:
- apiGroups: ["argoproj.io"]
  resources: ["applicationsets"]
  verbs: ["get","list","create","update","patch","delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cnp-portal-applicationsets
  namespace: argocd
subjects:
- kind: ServiceAccount
  name: cnp-portal
  namespace: cnp-portal
roleRef:
  kind: Role
  name: cnp-portal-applicationsets
  apiGroup: rbac.authorization.k8s.io
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cnp-portal-namespaces
rules:
- apiGroups: [""]
  resources: ["namespaces"]
  verbs: ["get","list","delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cnp-portal-namespaces
subjects:
- kind: ServiceAccount
  name: cnp-portal
  namespace: cnp-portal
roleRef:
  kind: ClusterRole
  name: cnp-portal-namespaces
  apiGroup: rbac.authorization.k8s.io
---
# Allows the portal to read the Cloud Run URL from the Crossplane V2Service status.
# Without this, getV2ServiceUrl() silently fails (catches 403) and the URL never appears.
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cnp-portal-crossplane-read
rules:
- apiGroups: ["cloudrun.gcp.upbound.io"]
  resources: ["v2services"]
  verbs: ["get","list"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cnp-portal-crossplane-read
subjects:
- kind: ServiceAccount
  name: cnp-portal
  namespace: cnp-portal
roleRef:
  kind: ClusterRole
  name: cnp-portal-crossplane-read
  apiGroup: rbac.authorization.k8s.io
EOF
```

After step 2, ArgoCD installs nginx-ingress and GCP assigns a LoadBalancer IP. The portal detects this IP automatically. Step 4 is required for app onboarding (ApplicationSets) and offboarding (namespace deletion). Without the namespace ClusterRole, deleted apps leave behind empty namespaces that must be cleaned up manually with `kubectl delete namespace {app}-dev {app}-prod`.

---

## GCP IAM requirements (Terraform)

| Service Account | Role needed | Why |
|---|---|---|
| GKE nodes default SA (`{project_number}-compute@developer.gserviceaccount.com`) | `roles/artifactregistry.reader` | Nodes must pull app images from GCP Artifact Registry |
| `github-ci-sa` | `roles/artifactregistry.writer` | CI pipeline pushes built images (already configured) |
| `crossplane-gcp-sa` | `roles/run.admin` + `roles/iam.serviceAccountUser` | Crossplane manages Cloud Run services |

**Without `artifactregistry.reader` on the node SA, all app pods stay in `ImagePullBackOff` and never start.**

---

## Running locally

```bash
npm install
cp .env.example .env   # fill in required vars
npm start              # http://localhost:3000
```

Health endpoints (no auth): `GET /healthz`, `GET /ready`

---

## Config-repo contract

The portal writes these paths into config-repo for each onboarded app (all templates in `src/services/onboarding.js`):

```
apps/{appName}/base/
  deployment.yaml               non-root, readOnlyRootFilesystem, /tmp emptyDir, liveness+readiness probes
  service.yaml                  ClusterIP on port 80 → container port
  kustomization.yaml
  netpol-default-deny.yaml
  netpol-allow-dns.yaml
  netpol-allow-ingress-ctrl.yaml
apps/{appName}/overlays/dev/
  kustomization.yaml            newTag: "placeholder" — CI replaces this on every push to main
  namespace.yaml
  configmap.yaml                LOG_LEVEL, DD_ENV, DD_SERVICE, DD_VERSION
  ingress.yaml                  host: {app}-dev.{INGRESS_IP}.nip.io — auto-detected at onboarding time
  pvc.yaml                      (only when "DB persistante" is checked) 1Gi ReadWriteOnce PVC mounted at /data
apps/{appName}/overlays/prod/
  (same files as dev; prod overlay uses 3 replicas patch)
apps/{appName}/crossplane/
  cloudrun-claim.yaml           Crossplane V2Service for Cloud Run (GCP only)
  cloudrun-iam.yaml             Public IAM binding for Cloud Run
  kustomization.yaml
  application.yaml              ArgoCD Application pointing to this crossplane/ dir
argocd/overlays/{appName}/
  kustomization.yaml            Kustomize overlay → patches base ApplicationSet templates
```

ArgoCD project used for all apps: `platform` (defined in `config-repo/argocd/projects/default-project.yaml`).

---

## Tests

```bash
npm test
```

Tests live in `test/index.test.js`. The CI pipeline runs them on every push.

---

## Docker / K8s (the portal itself)

```bash
# Build
docker build -t cnp-portal:local .

# Run
docker run --env-file .env -p 3000:3000 cnp-portal:local

# Deploy to cluster
kubectl apply -k k8s/overlays/dev
kubectl apply -k k8s/overlays/prod
```
