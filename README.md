# CNP Portal

Cloud Native Platform — Interface de gestion multi-cloud (MVP)


Developer's test-app-cnp repo
  └─ Creates new app (e.g., payments-service)
  └─ Pushes to main → CI builds image

GitHub Actions in test-app-cnp
  └─ [NEW STEP] Calls API to register app:
     POST https://your-api.example.com/v1/register-app
     {
       "app_name": "payments-service",
       "team_owner": "team-payments",
       "app_port": "3000",
       "repo_url": "https://github.com/Mooroon5-CNP/payments-service",
       "clusters": ["aws", "gcp"],
       "environments": ["dev", "prod"]
     }

API Handler (serverless function or webhook receiver)
  ├─ 1. Adds entry to registry.yaml (commit to config-repo)
  ├─ 2. Creates AppProject YAML for team-payments
  ├─ 3. Creates ApplicationSet YAML for payments-service
  └─ 4. kubectl apply both (OR: triggers Meta-Application)

Meta-Application (Phase 3.5)
  └─ Detects registry.yaml change
  └─ Auto-creates AppProject + ApplicationSets
  └─ Everything synced automatically

ArgoCD
  └─ New app now visible in UI
  └─ Deploys to dev automatically (main → dev overlay)
  └─ Awaits manual approval for prod (→ prod overlay)

## Stack

- **Runtime:** Node.js 20 + Express 4 + EJS (SSR)
- **Auth:** GitLab OAuth 2.0
- **Logs:** Winston (JSON structuré)
- **Container:** `node:20-alpine`, non-root, readOnlyRootFilesystem
- **K8s:** Kustomize (overlays `dev` / `prod`)
- **CI/CD:** GitLab CI — `lint → test → scan-secu → build → push`
- **Observabilité:** Datadog Unified Service Tagging

## Démarrage rapide

```bash
cp .env.example .env
# Remplissez GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET, SESSION_SECRET
npm install
npm start
# → http://localhost:3000
```

## Tests

```bash
npm test
```

## Build Docker

```bash
docker build -t cnp-portal:local .
docker run --env-file .env -p 3000:3000 cnp-portal:local
```

## Déploiement K8s

```bash
# Dev
kubectl apply -k k8s/overlays/dev

# Prod
kubectl apply -k k8s/overlays/prod
```

## Structure

```
src/
  index.js            Point d'entrée Express
  middleware/         auth, rbac, logger
  models/             user store (in-memory), token store
  routes/             auth, dashboard, deployments, k8s, observability, argocd, docs, admin
  services/           gitlab, k8s, datadog, argocd (mock → real post-MVP)
  views/              Templates EJS
public/               Assets statiques (CSS)
documentation/        Fichiers .md servis via /docs
k8s/                  Manifests Kubernetes (base + overlays dev/prod)
docs/adr/             Architecture Decision Records
```

## Rôles IAM

| Rôle | Description |
|------|-------------|
| `manager` | Accès complet |
| `devops` | Ops infra, CI/CD, K8s, observabilité |
| `dev` | Ses propres apps uniquement |

Voir [iam-matrix.md](iam-matrix.md) pour la matrice complète.

## Environnement

Variables requises — voir [.env.example](.env.example).

Les secrets de production sont injectés via K8s Secrets (`cnp-portal-{env}-{type}`), jamais committés.
