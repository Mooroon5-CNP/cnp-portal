# CNP Portal — Internal Developer Platform

A web portal that lets developers deploy GitHub-hosted apps to **Cloud Run on GCP** via GitOps (ArgoCD + Crossplane + Kustomize). The portal manages the full lifecycle: onboarding, CI wiring, Crossplane Cloud Run provisioning, and offboarding.

---

## What it does

A user submits a GitHub repo URL through the UI. The portal then automatically:

1. Writes K8s manifests into `config-repo` (`base/`, `overlays/dev/`, `overlays/prod/`) — stored as GitOps reference, not applied directly for GCP apps
2. Writes Crossplane manifests into `config-repo/apps/{app}/crossplane/` (`cloudrun-claim.yaml`, `cloudrun-iam.yaml`, optionally `gcs-bucket.yaml`)
3. Registers the app in `config-repo/apps/registry.yaml`
4. Applies the `cloudrun-autodiscovery` ArgoCD `ApplicationSet` on the cluster (idempotent — watches all `apps/*/crossplane/` dirs)
5. Commits `.github/workflows/ci.yml` to the app repo, wiring it to the reusable pipeline in [ci-templates](https://github.com/Mooroon5-CNP/ci-templates)
6. Injects into the app repo: `CONFIG_REPO_TOKEN` secret + `WIF_PROVIDER`, `GCP_SA_EMAIL`, `REGISTRY_URL` variables
7. Creates the `prod` branch in the app repo
8. Commits a trigger file (`.cnp-platform`) to fire the first CI run

If **DB persistante** is checked at onboarding, the portal also writes a `gcs-bucket.yaml` Crossplane manifest and configures the Cloud Run service to mount the bucket at `/data`.

When an app is deleted, the portal:
1. Removes all config-repo files (manifests, overlays, crossplane dir)
2. Calls the ArgoCD REST API with `cascade=true` to delete the ArgoCD `Application` — this prunes the Crossplane CRs, which triggers Crossplane to delete the Cloud Run service and GCS bucket (if `forceDestroy: true`)
3. Deletes the ArgoCD `Application` object

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
│   ├── kubernetes.js           k8s API client — pods, events, quotas, Crossplane V2Service status,
│   │                           applyApplicationSet, deleteApplicationSet,
│   │                           provisionArgoCDLocalUser (patches argocd-cm + argocd-secret)
│   └── datadog.js              Datadog metrics/logs/alerts client
├── services/
│   ├── onboarding.js           ★ Core logic — all config-repo writes + cloudrun-autodiscovery AppSet apply
│   │                           Contains all tpl* template functions for config-repo manifests.
│   ├── github.js               GitHub PAT helpers for config-repo reads/writes + CI run/job queries
│   ├── argocd.js               ArgoCD service layer (listApps, syncApp, requestAccess, approveAccess → auto-provisions ArgoCD local user)
│   ├── k8s.js                  K8s service layer (wraps kubernetes client for routes)
│   ├── teams.js                Team management (persists to SQLite)
│   └── datadog.js              Datadog service layer
├── routes/
│   ├── deployments.js          ★ Deployment CRUD — onboarding trigger, status polling, deletion workflow, team access
│   ├── auth.js                 Login/logout, GitHub OAuth callback
│   ├── dashboard.js            Home page
│   ├── admin.js                User management (manager only)
│   ├── teams.js                Team management routes
│   ├── argocd.js               ArgoCD — app listing, sync, access-request workflow (request / approve / reject / regenerate)
│   ├── k8s.js                  Pod/quota/event views + YAML editor (DevOps only)
│   ├── observability.js        Datadog metrics, logs, alerts
│   ├── profile.js              User profile
│   ├── health.js               /api/health JSON endpoint
│   └── documentation.js        In-app docs viewer
└── views/                      EJS templates (one per route, partials in views/partials/)
k8s/                            The portal's own Kubernetes manifests (base + dev/prod overlays)
data/                           SQLite database files (not committed)
```

---

## Key flow: deploying a new app (GCP Cloud Run)

```
POST /deployments
  └─ routes/deployments.js
       └─ onboardingService.onboardApp()               ← services/onboarding.js
            ├─ writeConfigRepoFile() ×10+              ← base + overlays + crossplane via githubService (PAT)
            ├─ updateRegistry()                        ← apps/registry.yaml
            ├─ k8sClient.applyApplicationSet()         ← cloudrun-autodiscovery AppSet (idempotent)
            ├─ githubClient.createOrUpdateFile()       ← .github/workflows/ci.yml in app repo (GitHub App)
            ├─ githubClient.setRepoSecret()            ← CONFIG_REPO_TOKEN secret in app repo
            ├─ githubClient.setRepoVariable() ×3       ← WIF_PROVIDER, GCP_SA_EMAIL, REGISTRY_URL
            ├─ githubClient.createBranch()             ← prod branch in app repo
            └─ githubClient.createOrUpdateFile()       ← .cnp-platform trigger commit → fires first CI run
```

After onboarding, CI takes over on every push to `main`:

```
push to main (app repo)
  └─ .github/workflows/ci.yml → ci-templates/pipeline.yml
       ├─ lint (eslint, hadolint)
       ├─ test
       ├─ scan-secrets (Gitleaks) / scan-deps (Trivy fs)
       ├─ build → push to europe-west9-docker.pkg.dev/cnp-terraform-500015/cnp-registry/{app}:{sha}
       ├─ scan-image (Trivy image) — fails on CRITICAL CVE
       └─ update-cloudrun-claim
            └─ sed image tag in config-repo/apps/{app}/crossplane/cloudrun-claim.yaml
                 └─► ArgoCD (cloudrun-autodiscovery AppSet) detects change
                       └─► Crossplane reconciles → Cloud Run service updated (~10 min)
                             └─► URL appears in portal once service is ready
```

---

## ArgoCD access workflow

Managers have ArgoCD access by default. DevOps and dev users must request it through the portal.

```
User visits /argocd
  └─ clicks "Demander un accès" (fills in reason + optional app name)
       └─ request saved to SQLite (argocd_access_requests table)

Manager visits /argocd
  └─ sees all pending requests
       └─ clicks "Approuver"
            └─ services/argocd.js → approveAccess()
                 ├─ generates ArgoCD username (sanitised portal username)
                 ├─ generates random 16-char password
                 ├─ bcrypt-hashes the password
                 ├─ patches argocd-cm  (accounts.<username>: apiKey,login)  via k8s API
                 ├─ patches argocd-secret (accounts.<username>.password)    via k8s API
                 └─ saves encrypted credentials to SQLite (AES-256-GCM)

User revisits /argocd
  └─ sees credentials (username + cleartext password + ArgoCD URL)
  └─ can regenerate credentials at any time via "Régénérer mes identifiants"
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

If the RBAC permission is missing, provisioning is logged as an error but the request is still marked approved and credentials are shown — a manager can create the ArgoCD account manually with those credentials.

---

## Roles and permissions

| Role | What they can do |
|---|---|
| `dev` | Deploy apps, view own pipelines and pods, request deletion |
| `devops` | Everything dev can + edit K8s manifests (YAML editor), manage team access |
| `manager` | Everything devops can + delete apps, approve users, modify roles |

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
| `ARGOCD_SERVER_URL` | ✅ | ArgoCD API base URL (in-cluster or external) |
| `ARGOCD_UI_URL` | — | Browser-accessible ArgoCD URL (falls back to `ARGOCD_SERVER_URL`) |
| `ARGOCD_TOKEN` | ✅ | ArgoCD bearer token |
| `ARGOCD_INSECURE` | — | `true` to skip TLS verification |
| `KUBE_API_URL` | ✅ | Kubernetes API server URL |
| `KUBE_TOKEN` | ✅ | Service account token — needs ApplicationSet RBAC in `argocd` namespace + Crossplane V2Service read |
| `KUBE_CA_CERT` | ✅ | Base64-encoded cluster CA certificate |
| `KUBE_NAMESPACE_PREFIX` | — | Filter namespaces shown in the portal (optional) |
| `DD_API_KEY` | ✅ | Datadog API key |
| `DD_APP_KEY` | ✅ | Datadog application key |
| `DD_SITE` | — | Datadog site (default: `datadoghq.com`) |
| `GCP_PROJECT` | — | GCP project ID (default: `cnp-terraform-500015`) |
| `GCP_REGION` | — | GCP region (default: `europe-west9`) |
| `GCP_IMAGE_REGISTRY` | — | Artifact Registry prefix (default: `europe-west9-docker.pkg.dev/cnp-terraform-500015/cnp-registry`) |
| `GCP_CLOUD_RUN_SA` | — | Cloud Run service account email |
| `GITHUB_WIF_PROVIDER` | — | Workload Identity Federation provider resource name |
| `GITHUB_GCP_SA_EMAIL` | — | GCP SA email injected as `GCP_SA_EMAIL` into app repos |
| `SESSION_SECRET` | — | Express session secret |
| `DB_PATH` | — | SQLite file path (default: `data/cnp-portal.sqlite`) |
| `PORT` | — | HTTP port (default: 3000) |

Copy `.env.example` to `.env` to get started locally.

---

## Changing GCP account or cluster — what to update

When you create a new cluster (Terraform re-apply), update these values in `.env` and in the portal's K8s ConfigMap:

### 1. Find `KUBE_API_URL`, `KUBE_CA_CERT`, `KUBE_TOKEN`

```bash
# API URL
kubectl cluster-info | grep "Kubernetes control plane"

# CA cert
kubectl config view --raw -o jsonpath=\
'{.clusters[?(@.name=="<CONTEXT>")].cluster.certificate-authority-data}'

# Service account token
kubectl get secret cnp-portal-token -n cnp-portal \
  -o jsonpath='{.data.token}' | base64 -d
```

### 2. Find `ARGOCD_SERVER_URL` and `ARGOCD_UI_URL`

```bash
kubectl get svc -n argocd | grep argocd-server
```

### 3. Find GCP-specific vars

```bash
gcloud config get-value project
# → GCP_PROJECT=cnp-terraform-500015

gcloud artifacts repositories list --project=<PROJECT_ID>
# → GCP_IMAGE_REGISTRY=europe-west9-docker.pkg.dev/<PROJECT>/cnp-registry
```

---

## Cluster bootstrap (one-time per cluster)

```bash
# 1. Create the ArgoCD AppProject
kubectl apply -f config-repo/argocd/projects/default-project.yaml

# 2. Install Crossplane (required for Cloud Run provisioning)
kubectl apply -f config-repo/infra/crossplane/application.yaml

# 3. Grant the portal's service account permissions to manage ApplicationSets
#    and read Crossplane V2Service status (for Cloud Run URL detection)
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

The `cnp-portal-crossplane-read` ClusterRole is required for the portal to read the Cloud Run URL from the Crossplane `V2Service` status. Without it, `getV2ServiceUrl()` silently fails (catches 403) and the URL never appears in the portal.

---

## GCP IAM requirements

| Service Account | Role needed | Why |
|---|---|---|
| `github-ci-sa` | `roles/artifactregistry.writer` | CI pushes built images to Artifact Registry |
| `crossplane-gcp-sa` | `roles/run.admin` + `roles/iam.serviceAccountUser` | Crossplane manages Cloud Run services |
| `crossplane-gcp-sa` | `roles/storage.admin` | Crossplane manages GCS buckets (if persistent storage used) |
| `cloud-run-sa` | `roles/storage.objectAdmin` on bucket | Cloud Run mounts the GCS bucket at `/data` |

---

## Config-repo structure written by the portal

```
apps/{appName}/base/
  deployment.yaml               K8s Deployment (reference — not applied for GCP Cloud Run apps)
  service.yaml
  kustomization.yaml
  netpol-*.yaml
apps/{appName}/overlays/dev/    (reference — not applied for GCP Cloud Run apps)
apps/{appName}/overlays/prod/   (reference — not applied for GCP Cloud Run apps)
apps/{appName}/crossplane/      ← what actually deploys on GCP
  cloudrun-claim.yaml           Crossplane V2Service → Cloud Run service
  cloudrun-iam.yaml             Public IAM binding (allUsers → roles/run.invoker)
  kustomization.yaml
  application.yaml              ArgoCD Application pointing to this crossplane/ dir
  gcs-bucket.yaml               (only when "DB persistante" is checked)
```

All templates are in `src/services/onboarding.js`.

---

## Running locally

```bash
npm install
cp .env.example .env   # fill in required vars
npm start              # http://localhost:3000
```

Health endpoints (no auth): `GET /healthz`, `GET /ready`

---

## Tests

```bash
npm test
```

Tests live in `test/index.test.js`. The CI pipeline runs them on every push.

---

## Docker / K8s (the portal itself)

```bash
docker build -t cnp-portal:local .
docker run --env-file .env -p 3000:3000 cnp-portal:local

# Deploy the portal to cluster
kubectl apply -k k8s/overlays/dev
kubectl apply -k k8s/overlays/prod
```
