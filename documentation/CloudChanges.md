# CloudChanges — Changements GCP pour test-app-cnp

Ce document liste **uniquement** les éléments propres à l'application **test-app-cnp** (CNP Portal) à modifier lors d'un changement de compte ou de projet GCP.

> Pour les opérations cluster/ArgoCD générales (ingress, ArgoCD insecure, token), voir [argocd-gcp-setup.md](./argocd-gcp-setup.md).

---

## Valeurs actuelles (projet `cnp-terraform-500015-508716`)

> Cluster recréé le 2026-09-15 (nouveau project ID auto-suffixé par GCP, nouvelle
> zone). Les valeurs ci-dessous ont été vérifiées le 2026-09-17.

| Variable `.env` | Valeur actuelle |
|---|---|
| `GCP_PROJECT` | `cnp-terraform-500015-508716` |
| Project Number | `352983558199` |
| Zone du cluster | `europe-west9-b` |
| `KUBE_API_URL` | `https://34.163.195.132` |
| `ARGOCD_SERVER_URL` / `ARGOCD_UI_URL` | Pas d'adresse publique pour l'instant — `ingress-nginx` n'est pas déployé sur ce cluster (l'Application ArgoCD existe mais échoue : "referencing project platform which does not exist", l'AppProject `platform` n'a jamais été créé ici). En attendant, `ARGOCD_TOKEN` a été généré via `kubectl port-forward svc/argocd-server -n argocd 8080:443` plutôt que via une URL publique. |

---

## 1. Variables d'environnement (`.env` / secrets Kubernetes)

### Variables qui dépendent du projet GCP

| Variable | Dépend de | Comment obtenir la nouvelle valeur |
|---|---|---|
| `GCP_PROJECT` | ID du projet GCP | Valeur textuelle du projet (ex: `cnp-terraform-500015-508716`) |
| `KUBE_API_URL` | Endpoint du cluster GKE | `gcloud container clusters describe <NOM_CLUSTER> --zone <ZONE> --format="value(endpoint)"` → `https://<IP>` |
| `KUBE_TOKEN` | Service account du portail sur le cluster | Voir [§ Obtenir KUBE_TOKEN](#obtenir-kube_token) |
| `KUBE_CA_CERT` | CA du cluster GKE | Voir [§ Obtenir KUBE_CA_CERT](#obtenir-kube_ca_cert) |
| `ARGOCD_SERVER_URL` | IP LoadBalancer ingress-nginx | `kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}'` → `http://argocd.<IP>.nip.io` |
| `ARGOCD_UI_URL` | Même IP | Identique à `ARGOCD_SERVER_URL` |
| `ARGOCD_TOKEN` | Instance ArgoCD du cluster | Voir [argocd-gcp-setup.md §6](./argocd-gcp-setup.md#étape-6--token-api-permanent) |

### Variables indépendantes de GCP (ne pas toucher)

| Variable | Raison |
|---|---|
| `GITHUB_APP_ID` | Lié au compte GitHub de l'org, pas à GCP |
| `GITHUB_APP_PRIVATE_KEY` | Idem |
| `GITHUB_APP_INSTALLATION_ID` | Idem |
| `GITHUB_CONFIG_REPO_NAME` | Idem |
| `GITHUB_CONFIG_REPO_TOKEN` | Idem |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth GitHub, pas GCP |
| `DD_API_KEY` / `DD_APP_KEY` | Compte Datadog, pas GCP |
| `SESSION_SECRET` | Généré localement |

---

## 2. Comment obtenir les nouvelles valeurs GCP

### Obtenir `GCP_PROJECT`

```bash
gcloud projects list
# Utiliser la valeur de la colonne PROJECT_ID
# Exemple : cnp-terraform-500015-508716
```

### Obtenir `KUBE_API_URL`

```bash
gcloud container clusters list
gcloud container clusters describe <NOM_CLUSTER> \
  --zone <ZONE> \
  --format="value(endpoint)"
# Préfixer avec https:// → KUBE_API_URL=https://<IP>
```

### Obtenir `KUBE_TOKEN`

```bash
# Créer le namespace et service account si besoin
kubectl create namespace cnp-portal --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount cnp-portal -n cnp-portal --dry-run=client -o yaml | kubectl apply -f -

# Créer un Secret de type token (k8s >= 1.24)
kubectl apply -f - <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: cnp-portal-token
  namespace: cnp-portal
  annotations:
    kubernetes.io/service-account.name: cnp-portal
type: kubernetes.io/service-account-token
EOF

sleep 5
kubectl get secret cnp-portal-token -n cnp-portal \
  -o jsonpath='{.data.token}' | base64 -d
# → KUBE_TOKEN=<valeur>
```

### Obtenir `KUBE_CA_CERT`

```bash
kubectl get secret cnp-portal-token -n cnp-portal \
  -o jsonpath='{.data.ca\.crt}'
# Résultat déjà en base64 → KUBE_CA_CERT=<valeur>
```

### Obtenir `ARGOCD_SERVER_URL`, `ARGOCD_UI_URL` et `ARGOCD_TOKEN`

```bash
INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "ARGOCD_SERVER_URL=http://argocd.${INGRESS_IP}.nip.io"
echo "ARGOCD_UI_URL=http://argocd.${INGRESS_IP}.nip.io"
```

Pour `ARGOCD_TOKEN` → voir [argocd-gcp-setup.md](./argocd-gcp-setup.md) étape 6.

---

## 3. RBAC Kubernetes du portail (à refaire sur chaque nouveau cluster)

Le portail a besoin de deux ensembles de permissions Kubernetes pour fonctionner correctement.

### Pourquoi c'est à refaire à chaque cluster

Ces `Role`/`ClusterRole` et leurs `Binding` sont des objets Kubernetes stockés **dans le cluster**. Un nouveau cluster repart de zéro — aucune permission n'est héritée.

### Appliquer les permissions

```bash
kubectl apply -f - <<EOF
# Permet au portail de créer/supprimer les ApplicationSets ArgoCD lors de l'onboarding/offboarding.
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
# Permet au portail de supprimer les namespaces applicatifs lors de la suppression d'une app.
# Sans cette permission, les namespaces {app}-dev et {app}-prod restent après suppression.
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
# Permet au portail de lire l'URL Cloud Run depuis le status du V2Service Crossplane.
# Sans cette permission, getV2ServiceUrl() échoue silencieusement (403 catch → null)
# et l'URL ne s'affiche jamais dans le portail, même après un pipeline réussi.
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

> **Note ArgoCD Applications** : la suppression des `Application` ArgoCD (lors de l'offboarding) passe par l'API REST ArgoCD avec `ARGOCD_TOKEN` — pas par le K8s API. Pas de RBAC K8s supplémentaire nécessaire pour ça.

### Automatiser avec Terraform

Si le cluster GKE est provisionné via Terraform, ces RBAC peuvent être appliqués automatiquement avec le provider `kubernetes` :

```hcl
resource "kubernetes_role" "cnp_portal_applicationsets" {
  metadata {
    name      = "cnp-portal-applicationsets"
    namespace = "argocd"
  }
  rule {
    api_groups = ["argoproj.io"]
    resources  = ["applicationsets"]
    verbs      = ["get", "list", "create", "update", "patch", "delete"]
  }
}

resource "kubernetes_role_binding" "cnp_portal_applicationsets" {
  metadata {
    name      = "cnp-portal-applicationsets"
    namespace = "argocd"
  }
  subject {
    kind      = "ServiceAccount"
    name      = "cnp-portal"
    namespace = "cnp-portal"
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "Role"
    name      = kubernetes_role.cnp_portal_applicationsets.metadata[0].name
  }
}

resource "kubernetes_cluster_role" "cnp_portal_namespaces" {
  metadata {
    name = "cnp-portal-namespaces"
  }
  rule {
    api_groups = [""]
    resources  = ["namespaces"]
    verbs      = ["get", "list", "delete"]
  }
}

resource "kubernetes_cluster_role_binding" "cnp_portal_namespaces" {
  metadata {
    name = "cnp-portal-namespaces"
  }
  subject {
    kind      = "ServiceAccount"
    name      = "cnp-portal"
    namespace = "cnp-portal"
  }
  role_ref {
    api_group = "rbac.authorization.k8s.io"
    kind      = "ClusterRole"
    name      = kubernetes_cluster_role.cnp_portal_namespaces.metadata[0].name
  }
}
```

> **Prérequis Terraform** : le namespace `argocd` doit exister avant d'appliquer le `Role` (ArgoCD doit être installé d'abord). Utiliser `depends_on` sur la ressource ArgoCD si nécessaire. Le namespace `cnp-portal` et le `ServiceAccount` `cnp-portal` doivent aussi exister avant les `Binding`.

---

## 4. Fichiers de code à mettre à jour

### `ci-templates/.github/workflows/pipeline.yml` et `build-push-artifact-registry.yml`

**Mise à jour 2026-09-17 : ces fichiers ne contiennent plus rien en dur.** Ils lisent
`${{ vars.WIF_PROVIDER }}`, `${{ vars.GCP_SA_EMAIL }}` et `${{ vars.REGISTRY_URL }}` —
des variables GitHub Actions définies **par repo applicatif** (Settings → Secrets and
variables → Actions → Variables), pas dans ces fichiers. Rien à `sed` ici.

En cas de changement de projet GCP, c'est donc dans **chaque repo d'application**
(ex. `cnp-portal`) qu'il faut mettre à jour ces 3 variables, avec :

| Variable GitHub Actions | Nouvelle valeur |
|---|---|
| `WIF_PROVIDER` | `projects/352983558199/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| `GCP_SA_EMAIL` | `github-ci-sa@cnp-terraform-500015-508716.iam.gserviceaccount.com` |
| `REGISTRY_URL` | `europe-west9-docker.pkg.dev/cnp-terraform-500015-508716/cnp-registry` |

### `test-app-cnp/src/config/env.js`

Le default de `GCP_PROJECT` est lu depuis l'env var, avec une valeur de secours codée en dur.
**Mise à jour 2026-09-17 :** cette valeur de secours (ainsi que celles de `wifProvider`,
`gcpSaEmail`, `imageRegistry` et `cloudRunSa`, qui en dépendent) a été alignée sur le
projet actuel :
```javascript
project: process.env.GCP_PROJECT || 'cnp-terraform-500015-508716',
```
En production : toujours passer `GCP_PROJECT` en variable d'environnement plutôt que de modifier le code — ces valeurs de secours ne servent qu'en dev local sans `.env` complet.

---

## 4. Manifests Kubernetes du portail (`k8s/`)

Si le portail est déployé **sur le cluster GKE**, l'image Docker contient le nom du projet :

```
europe-west9-docker.pkg.dev/<NOM_PROJET_GCP>/cnp-registry/cnp-portal:<tag>
```

**Constat 2026-09-17 : ce n'est pas le cas actuellement.** Le portail est onboardé
sur sa propre plateforme (`.cnp-platform`) et tourne en réalité sur **Cloud Run**,
piloté par `config-repo/apps/cnp-portal/crossplane/cloudrun-claim.yaml` — pas par
les manifests `k8s/` de ce repo, qui restent une référence non appliquée pour ce
type d'app (voir le File map en tête de README). Rien à modifier ici tant que ça
reste le cas ; si le portail repasse un jour en déploiement K8s direct, les
fichiers `k8s/base/deployment.yaml`, `k8s/overlays/dev/kustomization.yaml` et
`k8s/overlays/prod/kustomization.yaml` (champ `image:` / `images[].name`)
devront alors être alignés sur le project ID courant.

---

## 5. IAM GCP requis (Terraform)

Ces permissions doivent exister sur le nouveau projet — vérifier avec `gcloud projects get-iam-policy <PROJECT>` :

| Service Account | Rôle | Pourquoi |
|---|---|---|
| `gke-nodes-sa@<PROJECT>.iam.gserviceaccount.com` | `roles/artifactregistry.reader` | Les nœuds GKE doivent pouvoir pull les images |
| `github-ci-sa@<PROJECT>.iam.gserviceaccount.com` | `roles/artifactregistry.writer` | CI pipeline push les images buildées |
| `crossplane-gcp-sa@<PROJECT>.iam.gserviceaccount.com` | `roles/run.admin` + `roles/iam.serviceAccountUser` | Crossplane gère Cloud Run |

Sur `cnp-terraform-500015-508716`, ces rôles n'ont pas été revérifiés depuis la
recréation du cluster — à confirmer avec `gcloud projects get-iam-policy cnp-terraform-500015-508716`.

---

## 6. Checklist de migration — résumé

État au 2026-09-17, pour la migration vers `cnp-terraform-500015-508716` :

```
☑ Nouveau cluster GKE provisionné (Terraform) — cnp-cluster-terraform, europe-west9-b

☑ Bootstrap cluster (une fois, kubectl) :
    ☐ kubectl apply -f config-repo/argocd/projects/default-project.yaml
         → PAS FAIT : AppProject "platform" absent sur ce cluster (seuls
           "default" et "team-cnp" existent). C'est pour ça que l'Application
           ArgoCD "ingress-nginx" est bloquée en erreur "referencing project
           platform which does not exist".
    ☐ kubectl apply -f config-repo/infra/ingress-nginx/application.yaml
         → Application déjà enregistrée dans ArgoCD mais jamais synced (dépend
           du point ci-dessus). Pas d'IP publique pour l'instant.
    ☑ crossplane — déjà installé et sain (crossplane-config / crossplane-providers
      Synced/Healthy dans ArgoCD)
    ☑ RBAC portail appliqué (voir §3) — Role applicationsets + ClusterRole
      namespaces + ClusterRole crossplane-read

☑ ArgoCD — compte cnp-portal créé + RBAC + token API généré, mais **via
  `kubectl port-forward svc/argocd-server -n argocd 8080:443`**, pas via une
  URL publique (puisque ingress-nginx n'est pas up). Donc pas de "Mode
  insecure" ni d'Ingress créés pour l'instant — inutile tant qu'on n'expose
  pas ArgoCD publiquement.

☑ Secret cnp-portal-cloud-access créé dans le namespace cnp-portal, avec :
    ☑ KUBE_TOKEN, KUBE_CA_CERT
    ☑ ARGOCD_TOKEN
    ☑ GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY
    ☑ GITHUB_CONFIG_REPO_TOKEN
    ☐ DD_API_KEY / DD_APP_KEY — pas nécessaire au démarrage de l'appli (voir
      src/clients/datadog.js : erreur seulement si on ouvre la page Observability),
      laissé de côté pour l'instant

☑ ci-templates — rien à mettre à jour (plus de valeurs en dur, voir §4). Les
  variables GitHub Actions (WIF_PROVIDER, GCP_SA_EMAIL, REGISTRY_URL) sont à
  vérifier/mettre à jour par repo applicatif si besoin.

☑ src/config/env.js — valeurs de secours mises à jour vers cnp-terraform-500015-508716

☐ IAM vérifié — pas revérifié sur le nouveau projet (voir §5)
```

**Ce qui reste ouvert si le portail doit un jour fonctionner en conditions
réelles (pas juste avoir les accès prêts)** : l'AppProject `platform` et
`ingress-nginx` doivent être bootstrapés pour qu'ArgoCD ait une URL publique
que `ARGOCD_SERVER_URL` puisse référencer.
