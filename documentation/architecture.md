# Architecture CNP Platform — MVP

## Vue d'ensemble

La CNP Platform gère des déploiements sur **3 clouds** :
- **GCP** — Google Cloud Platform (public)
- **AWS** — Amazon Web Services (public)
- **Cloud privé à def** — 

## Stack applicative

```
CNP Portal (Node.js 20 + Express + EJS)
    │
    ├── Auth: GitHub OAuth 2.0 (github.com) + compte local admin
    ├── Sessions: express-session (in-memory — Redis post-MVP)
    ├── Logs: Winston JSON → Datadog
    └── Deploy: GitHub App → config-repo (GitOps) → ArgoCD → Crossplane / Cloud Run
```

## Kubernetes

- Namespace: `cnp-portal`
- Manifestes gérés par **Kustomize** (overlays `dev` / `prod`)
- Helm uniquement pour les charts tiers (Datadog Agent, cert-manager, Nginx Ingress)
- Pod Security Standards: `baseline`
- SecurityContext: `runAsNonRoot: true`, `readOnlyRootFilesystem: true`

## CI/CD

Pipeline GitHub Actions (workflow réutilisable `Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml`) :
```
lint → test → scan-secu (Trivy) → build → push → update config-repo
```

- CRITICAL CVEs : bloquant
- HIGH/MEDIUM CVEs : warning (non bloquant au MVP)
- Registry : GCP Artifact Registry (`europe-west9-docker.pkg.dev/<projet-gcp>/cnp-registry/<app>`)

## Observabilité

Datadog Unified Service Tagging :
```
DD_ENV=prod|dev
DD_SERVICE=cnp-portal
DD_VERSION=1.0.0
```

Logs en format JSON structuré, niveau INFO en production.

## Secrets

Convention de nommage : `{app}-{env}-{type}`

Exemples :
- `cnp-portal-prod-github-oauth`
- `cnp-portal-prod-session-secret`
- `cnp-portal-prod-datadog-api-key`

Les valeurs des secrets ne sont jamais exposées dans l'interface.

## Décisions d'architecture

Voir le dossier `docs/adr/` pour les ADRs.
