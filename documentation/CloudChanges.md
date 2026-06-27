# CloudChanges — Changements GCP pour test-app-cnp

Ce document liste **uniquement** les éléments propres à l'application **test-app-cnp** (CNP Portal) à modifier lors d'un changement de compte ou de projet GCP.

> Pour les opérations cluster/ArgoCD générales (ingress, ArgoCD insecure, token), voir [argocd-gcp-setup.md](./argocd-gcp-setup.md).

---

## Valeurs actuelles (projet `cnp-terraform-500015`)

| Variable `.env` | Valeur actuelle |
|---|---|
| `GCP_PROJECT` | `cnp-terraform-500015` |
| `KUBE_API_URL` | `https://34.163.86.239` |
| `ARGOCD_SERVER_URL` | `http://argocd.34.155.213.145.nip.io` |
| `ARGOCD_UI_URL` | `http://argocd.34.155.213.145.nip.io` |

---

## 1. Variables d'environnement (`.env` / secrets Kubernetes)

### Variables qui dépendent du projet GCP

| Variable | Dépend de | Comment obtenir la nouvelle valeur |
|---|---|---|
| `GCP_PROJECT` | ID du projet GCP | Valeur textuelle du projet (ex: `cnp-terraform-500015`) |
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
# Exemple : cnp-terraform-500015
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

Ces fichiers contiennent le project ID, project number et SA GCP en dur. À mettre à jour :

| Valeur | Ancienne | Nouvelle |
|---|---|---|
| Project ID | `cnp-terraform` | `cnp-terraform-500015` |
| Project Number | `199851303237` | `688655933459` |
| GitHub CI SA | `github-ci-sa@cnp-terraform.iam.gserviceaccount.com` | `github-ci-sa@cnp-terraform-500015.iam.gserviceaccount.com` |
| AR Registry | `europe-west9-docker.pkg.dev/cnp-terraform/cnp-registry` | `europe-west9-docker.pkg.dev/cnp-terraform-500015/cnp-registry` |
| WIF provider | `projects/199851303237/locations/...` | `projects/688655933459/locations/...` |

Commande rapide pour tout remplacer :
```bash
OLD_PROJECT="cnp-terraform"
NEW_PROJECT="cnp-terraform-500015"
OLD_NUMBER="199851303237"
NEW_NUMBER="688655933459"

for FILE in ci-templates/.github/workflows/pipeline.yml \
            ci-templates/.github/workflows/build-push-artifact-registry.yml; do
  sed -i \
    -e "s|projects/${OLD_NUMBER}/|projects/${NEW_NUMBER}/|g" \
    -e "s|github-ci-sa@${OLD_PROJECT}\.iam|github-ci-sa@${NEW_PROJECT}.iam|g" \
    -e "s|europe-west9-docker\.pkg\.dev/${OLD_PROJECT}/|europe-west9-docker.pkg.dev/${NEW_PROJECT}/|g" \
    "$FILE"
done
```

### `test-app-cnp/src/config/env.js`

Le default de `GCP_PROJECT` est lu depuis l'env var. Mettre à jour la valeur par défaut si le projet change durablement :
```javascript
project: process.env.GCP_PROJECT || 'cnp-terraform-500015',
```
En production : toujours passer `GCP_PROJECT` en variable d'environnement plutôt que de modifier le code.

---

## 4. Manifests Kubernetes du portail (`k8s/`)

Si le portail est déployé **sur le cluster GKE**, l'image Docker contient le nom du projet :

```
europe-west9-docker.pkg.dev/<NOM_PROJET_GCP>/cnp-registry/cnp-portal:<tag>
```

Fichiers à mettre à jour :

| Fichier | Champ |
|---|---|
| `k8s/base/deployment.yaml` | `image:` |
| `k8s/overlays/dev/kustomization.yaml` | `images[].newName` |
| `k8s/overlays/prod/kustomization.yaml` | `images[].newName` |

Commande :
```bash
find k8s/ -name "*.yaml" -exec sed -i \
  "s|europe-west9-docker.pkg.dev/cnp-terraform/|europe-west9-docker.pkg.dev/cnp-terraform-500015/|g" {} \;
```

---

## 5. IAM GCP requis (Terraform)

Ces permissions doivent exister sur le nouveau projet — vérifier avec `gcloud projects get-iam-policy <PROJECT>` :

| Service Account | Rôle | Pourquoi |
|---|---|---|
| `gke-nodes-sa@<PROJECT>.iam.gserviceaccount.com` | `roles/artifactregistry.reader` | Les nœuds GKE doivent pouvoir pull les images |
| `github-ci-sa@<PROJECT>.iam.gserviceaccount.com` | `roles/artifactregistry.writer` | CI pipeline push les images buildées |
| `crossplane-gcp-sa@<PROJECT>.iam.gserviceaccount.com` | `roles/run.admin` + `roles/iam.serviceAccountUser` | Crossplane gère Cloud Run |

Sur `cnp-terraform-500015`, `gke-nodes-sa` a déjà `artifactregistry.reader` ✅

---

## 6. Checklist de migration — résumé

```
□ Nouveau cluster GKE provisionné (Terraform)

□ Bootstrap cluster (une fois, kubectl) :
    □ kubectl apply -f config-repo/argocd/projects/default-project.yaml
    □ kubectl apply -f config-repo/infra/ingress-nginx/application.yaml
    □ kubectl apply -f config-repo/infra/crossplane/application.yaml
    □ RBAC portail appliqué (voir §3) — Role applicationsets + ClusterRole namespaces + ClusterRole crossplane-read

□ ArgoCD configuré (voir argocd-gcp-setup.md) :
    □ Mode insecure activé
    □ Ingress créé  →  http://argocd.<IP>.nip.io
    □ Compte cnp-portal créé + RBAC configuré
    □ Token API généré

□ .env mis à jour :
    □ GCP_PROJECT=<nouveau-project-id>
    □ KUBE_API_URL=https://<endpoint-cluster>
    □ KUBE_TOKEN=<token SA cnp-portal>
    □ KUBE_CA_CERT=<base64 CA>
    □ ARGOCD_SERVER_URL=http://argocd.<IP>.nip.io
    □ ARGOCD_UI_URL=http://argocd.<IP>.nip.io
    □ ARGOCD_TOKEN=<token généré>

□ ci-templates mis à jour (project ID, number, SA, registry)

□ IAM vérifié :
    □ gke-nodes-sa a roles/artifactregistry.reader
    □ github-ci-sa a roles/artifactregistry.writer
```
