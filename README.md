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

After that the CI pipeline is self-contained: on each push to `main` it builds the image, pushes to GCP Artifact Registry, updates `newTag` in config-repo, and ArgoCD syncs automatically.

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
│   └── tokenStore.js           OAuth state token storage
├── middleware/
│   ├── auth.js                 populateUser (session → req.user), requireAuth, requirePending
│   ├── rbac.js                 PERMISSIONS map + can() / requirePermission() / requireRole()
│   └── logger.js               Pino-based structured logger + request middleware
├── clients/
│   ├── github.js               GitHub App client — createOrUpdateFile, setRepoSecret, createBranch, getRef, getLatestRun, getRuns, getRunJobs
│   ├── argocd.js               ArgoCD REST client — listApplications, syncApplication
│   ├── kubernetes.js           k8s API client — pods, namespaces, events, quotas, Crossplane XRDs, applyApplicationSet, deleteApplicationSet
│   └── datadog.js              Datadog metrics/logs/alerts client
├── services/
│   ├── onboarding.js           ★ Core logic — all config-repo writes + ApplicationSet apply/delete; contains all tpl* template functions
│   ├── github.js               GitHub PAT helpers for config-repo reads/writes + CI run/job queries
│   ├── argocd.js               ArgoCD service layer (listApps, syncApp, access requests)
│   ├── k8s.js                  K8s service layer (wraps kubernetes client for routes)
│   ├── teams.js                Team management (persists to SQLite)
│   ├── gitlab.js               Legacy GitLab client (not used in main flow)
│   └── datadog.js              Datadog service layer
├── routes/
│   ├── deployments.js          ★ Deployment CRUD — onboarding trigger, status polling, deletion workflow, team access
│   ├── auth.js                 Login/logout, GitHub OAuth callback
│   ├── dashboard.js            Home page
│   ├── admin.js                User management (manager only)
│   ├── teams.js                Team management routes
│   ├── argocd.js               ArgoCD app listing and sync
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
                 └─ ArgoCD webhook detects change → syncs dev namespace automatically
```

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

| Variable | Purpose |
|---|---|
| `GITHUB_APP_ID` | GitHub App ID — used for app-repo operations (ci.yml, secrets, branches) |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM; `\n`-escaped single-line is accepted) |
| `GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID on the org |
| `GITHUB_CONFIG_REPO_NAME` | `owner/repo` of the GitOps config-repo (default: `Mooroon5-CNP/config-repo`) |
| `GITHUB_CONFIG_REPO_TOKEN` | Fine-grained PAT with Contents:write on config-repo |
| `ARGOCD_SERVER_URL` | ArgoCD API base URL |
| `ARGOCD_TOKEN` | ArgoCD bearer token |
| `ARGOCD_INSECURE` | `true` to skip TLS verification |
| `KUBE_API_URL` | GKE API server URL |
| `KUBE_TOKEN` | Service account token with permissions to manage ApplicationSets in `argocd` namespace |
| `KUBE_CA_CERT` | Base64-encoded cluster CA certificate |
| `KUBE_NAMESPACE_PREFIX` | Filter namespaces shown in the portal (optional) |
| `DD_API_KEY` | Datadog API key |
| `DD_APP_KEY` | Datadog application key |
| `DD_SITE` | Datadog site (default: `datadoghq.com`) |
| `SESSION_SECRET` | Express session secret |
| `DB_PATH` | SQLite file path (default: `data/cnp-portal.sqlite`) |
| `PORT` | HTTP port (default: 3000) |

Copy `.env.example` to `.env` to get started locally.

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
  ingress.yaml                  cert-manager TLS, host: {app}-dev.cnp.example.com
apps/{appName}/overlays/prod/
  (same four files, 3 replicas in prod patch)
argocd/overlays/{appName}/
  kustomization.yaml            Kustomize overlay → patches base ApplicationSet templates with app name + team
```

Image registry for all apps: `europe-west9-docker.pkg.dev/cnp-terraform/cnp-registry/{appName}`

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
