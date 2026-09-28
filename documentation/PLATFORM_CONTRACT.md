# Platform Contract

Ce document décrit ce que la plateforme CNP fait réellement. Il ne contient que ce qui est vérifiable dans le code.

---

## 1. Ce que la plateforme fait automatiquement à l'onboarding

Lorsqu'un déploiement est créé via le CNP Portal :

1. Écrit les manifests K8s dans `config-repo/apps/<app>/base/` et `overlays/dev/` + `prod/` (référentiels GitOps — non appliqués directement sur le cluster pour les apps GCP)
2. Écrit les manifests Crossplane dans `config-repo/apps/<app>/crossplane/` : `cloudrun-claim.yaml`, `cloudrun-iam.yaml`, et optionnellement `gcs-bucket.yaml`
3. Enregistre l'app dans `config-repo/apps/registry.yaml`
4. Applique l'ApplicationSet ArgoCD `cloudrun-autodiscovery` sur le cluster (idempotent — surveille tous les `apps/*/crossplane/`)
5. Crée `.github/workflows/ci.yml` dans le dépôt de l'application via GitHub App
6. Injecte automatiquement dans le dépôt de l'application :
   - Secret `CONFIG_REPO_TOKEN`
   - Variable `WIF_PROVIDER`
   - Variable `GCP_SA_EMAIL`
   - Variable `REGISTRY_URL`
7. Crée la branche `prod` dans le dépôt de l'application
8. Déclenche le premier pipeline CI immédiatement

---

## 2. Architecture de déploiement

```
push → main (dépôt de l'application)
  └─► GitHub Actions CI (pipeline.yml@main)
        ├─ build image Docker
        ├─ push vers Artifact Registry
        │   europe-west9-docker.pkg.dev/cnp-terraform-500015/cnp-registry/<app>:<sha>
        └─ update-cloudrun-claim : met à jour le tag image dans
              config-repo/apps/<app>/crossplane/cloudrun-claim.yaml
                └─► ArgoCD (cloudrun-autodiscovery ApplicationSet)
                      └─► Crossplane → Cloud Run
                            projet : cnp-terraform-500015
                            région : europe-west9
```

Le déploiement sur Cloud Run prend **environ 10 minutes** après la fin du pipeline CI.

L'URL Cloud Run apparaît dans le Portal dès que Crossplane a fini de provisionner le service (~1–3 min après le CI).

---

## 3. Contraintes imposées par la plateforme

### 3.1 Endpoints obligatoires

La plateforme configure des health checks sur votre conteneur. **Votre application doit exposer :**

| Endpoint | Usage | Délai initial |
|---|---|---|
| `GET /healthz` | Liveness — si KO → redémarrage | 10 s |
| `GET /ready` | Readiness — si KO → plus de trafic | 5 s |

Ces endpoints doivent répondre `200 OK`. Cloud Run refusera le trafic jusqu'à ce que `/ready` réponde.

### 3.2 Port applicatif

Le port déclaré dans le CNP Portal doit correspondre exactement au port que votre application écoute (et à `EXPOSE` dans le Dockerfile). C'est ce port qui est configuré dans le `cloudrun-claim.yaml`.

### 3.3 Variables d'environnement injectées automatiquement

La plateforme injecte dans chaque conteneur via ConfigMap :

| Variable | Valeur |
|---|---|
| `LOG_LEVEL` | `INFO` |
| `DD_ENV` | `dev` ou `prod` |
| `DD_SERVICE` | `<app-name>` |
| `DD_VERSION` | `1.0.0` |
| `DATA_DIR` | `/data` (si stockage GCS activé) ou `/tmp` |

---

## 4. Stockage persistant (optionnel)

Si activé à la création du déploiement :
- Un bucket GCS `cnp-<app>-data` est créé dans le projet GCP
- Monté à `/data` dans le conteneur Cloud Run
- Le bucket est créé avec `forceDestroy: false` — **si le bucket contient des données au moment de la suppression de l'app, GCP refusera de le détruire.** Il faudra le vider manuellement avant de demander la suppression.
- Les données du bucket sont **de votre responsabilité**. La plateforme ne fait aucun backup.

---

## 5. Modifications de configuration post-onboarding

Toute modification des manifests Crossplane (variables d'env, ressources Cloud Run, etc.) passe par une **Pull Request** sur `config-repo`, validée par un manager.

Flux :
1. DevOps utilise l'éditeur YAML dans le Portal (`config-repo/apps/<app>/crossplane/cloudrun-claim.yaml`)
2. Une PR est créée automatiquement
3. Un manager approuve ou refuse
4. ArgoCD synchronise après merge → Crossplane met à jour le service Cloud Run

**Pas de commit direct sur `main` du config-repo.**

---

## 6. Responsabilités

### La plateforme (DevOps / Managers)
- Maintient le CNP Portal, le config-repo et les templates CI
- Valide les PRs sur config-repo
- Approuve les demandes d'accès ArgoCD
- Approuve les créations et suppressions d'applications
- Gère les variables GCP injectées (`WIF_PROVIDER`, `GCP_SA_EMAIL`, `REGISTRY_URL`)
- Ajoute les variables d'environnement custom dans `cloudrun-claim.yaml` sur demande des développeurs

### Les développeurs
- Sont responsables du code applicatif et du Dockerfile
- Exposent `/healthz` et `/ready` sur leur application
- S'assurent que l'image build sans erreur sur `main`
- Ne commitent pas de secrets dans le code
- Passent par le Portal (ou demandent au DevOps) pour toute modification d'infrastructure
- Vident le bucket GCS avant de demander la suppression de l'application si le stockage était activé

---

## 7. Accès ArgoCD

L'accès à l'interface ArgoCD est sur demande :
1. L'utilisateur fait une demande depuis le Portal (section ArgoCD)
2. Un manager approuve
3. Un compte local ArgoCD est créé automatiquement et les identifiants sont affichés dans le Portal
4. L'utilisateur peut régénérer ses identifiants depuis le Portal à tout moment

---

*Basé sur `src/services/onboarding.js`, `src/clients/kubernetes.js`, `src/config/env.js`*
*Dernière mise à jour : 2026-06-29*
