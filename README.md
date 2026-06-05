# CNP Portal

Cloud Native Platform — Interface de gestion multi-cloud (MVP)

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
