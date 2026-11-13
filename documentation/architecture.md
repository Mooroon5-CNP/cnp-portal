# Architecture CNP Platform — MVP

## Accès applicatif — mise à jour du 11 novembre 2026

Une vérification SQLite/PostgreSQL du dépôt précède désormais la création du déploiement. Une incompatibilité détectée bloque la soumission sans inscription ni provisioning et conserve le formulaire pour correction.

Le correctif sépare la publication GitOps de l’accès utilisateur. GitHub Actions → portail → config-repo → ArgoCD → Crossplane → Cloud Run reste le parcours de publication. Pour une application GCP simple en dev/prod, sans PostgreSQL ni failover, le navigateur utilise désormais l’URI HTTPS native Cloud Run observée et vérifiée. Le domaine personnalisé n’est plus une condition de disponibilité de cette offre.

Les parcours PostgreSQL, failover, Azure et historiques conservent leurs adresses et contrôles. Les anciennes ressources réseau sont préservées lors des mises à jour ; les nouvelles applications simples ne créent plus de NEG/backend dédié au routage partagé. Les buckets et données ne sont pas migrés par ce changement.

Voir [Accès applicatif et approbations ArgoCD](../../documentation/architecture/acces-applicatif.md) pour la matrice des offres, les contrôles HTTPS, le cycle de vie et la règle d’approbation par le compte local `admin`. Cette référence décrit les sources locales ; elle ne certifie pas l’état de tous les déploiements live. Les sections MVP ci-dessous constituent un contexte historique et ne remplacent pas cette mise à jour.

La [suppression applicative](../../documentation/architecture/suppression-applicative.md) utilise désormais une tâche durable : inventaire, autorisation explicite de détruire les données GCS, retrait GitOps, vérification de disparition, puis nettoyage des artefacts CI générés si aucun environnement ne les utilise encore. Les attentes normales ArgoCD sont reprises automatiquement.

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
