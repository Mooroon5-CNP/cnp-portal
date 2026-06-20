# CloudChanges — Changements GCP pour test-app-cnp

Ce document liste **uniquement** les éléments propres à l'application **test-app-cnp** (CNP Portal) à modifier lors d'un changement de compte ou de projet GCP.

> Pour les opérations cluster/ArgoCD générales (ingress, service accounts, etc.), voir [argocd-gcp-setup.md](./argocd-gcp-setup.md).

---

## 1. Variables d'environnement (`.env` / secrets Kubernetes)

### Variables qui dépendent du projet GCP

| Variable | Dépend de | Comment obtenir la nouvelle valeur |
|---|---|---|
| `ARGOCD_SERVER_URL` | IP LoadBalancer du cluster | `kubectl get svc ingress-nginx-controller -n ingress-nginx -o jsonpath='{.status.loadBalancer.ingress[0].ip}'` → `http://argocd.<IP>.nip.io` |
| `ARGOCD_UI_URL` | Même IP | Idem, même valeur que `ARGOCD_SERVER_URL` |
| `ARGOCD_TOKEN` | Instance ArgoCD du cluster | Voir [argocd-gcp-setup.md §6](./argocd-gcp-setup.md#6-générer-le-token-api-permanent) |
| `KUBE_API_URL` | Endpoint du cluster GKE | `gcloud container clusters describe <NOM_CLUSTER> --zone <ZONE> --format="value(endpoint)"` → `https://<IP>` |
| `KUBE_TOKEN` | Service account du portail | Voir ci-dessous — [§ Obtenir KUBE_TOKEN](#obtenir-kube_token) |
| `KUBE_CA_CERT` | CA du cluster GKE | Voir ci-dessous — [§ Obtenir KUBE_CA_CERT](#obtenir-kube_ca_cert) |

### Variables indépendantes de GCP (ne pas toucher)

| Variable | Raison |
|---|---|
| `GITHUB_APP_ID` | Lié au compte GitHub de l'org, pas à GCP |
| `GITHUB_APP_PRIVATE_KEY` | Idem |
| `GITHUB_APP_INSTALLATION_ID` | Idem |
| `GITHUB_CONFIG_REPO_NAME` | Idem |
| `GITHUB_CONFIG_REPO_TOKEN` | Idem |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | OAuth GitHub, pas GCP |
| `GITLAB_*` | OAuth GitLab, pas GCP |
| `DD_API_KEY` / `DD_APP_KEY` | Compte Datadog, pas GCP |
| `SESSION_SECRET` | Généré localement |
| `DEPLOYMENTS_SECRET` | Généré localement |

---

## 2. Comment obtenir les nouvelles valeurs GCP

### Obtenir `KUBE_API_URL`

```bash
gcloud container clusters list
# Repérer le cluster, puis :
gcloud container clusters describe <NOM_CLUSTER> \
  --zone <ZONE> \
  --format="value(endpoint)"
# Préfixer avec https:// → KUBE_API_URL=https://<IP>
```

### Obtenir `KUBE_TOKEN`

Le portail doit utiliser un service account Kubernetes dédié. Si le cluster a changé, recréer le service account et extraire son token :

```bash
# Créer le service account (si pas encore fait)
kubectl create serviceaccount cnp-portal -n cnp-portal --dry-run=client -o yaml | kubectl apply -f -

# Créer un Secret de type token (k8s >= 1.24 ne génère plus de token automatiquement)
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

# Attendre que le token soit injecté puis l'extraire
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

### Obtenir `ARGOCD_SERVER_URL` et `ARGOCD_UI_URL`

```bash
INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "ARGOCD_SERVER_URL=http://argocd.${INGRESS_IP}.nip.io"
echo "ARGOCD_UI_URL=http://argocd.${INGRESS_IP}.nip.io"
```

### Obtenir `ARGOCD_TOKEN`

Voir [argocd-gcp-setup.md](./argocd-gcp-setup.md) — la procédure complète (mode insecure, ingress, compte service, token) doit être rejouée sur le nouveau cluster.

---

## 3. Manifests Kubernetes du portail lui-même (`k8s/`)

Si le portail est déployé **sur le cluster GKE** (pas seulement en local), deux éléments changent.

### 3a. Image Docker — Artifact Registry

Le portail est buildé et poussé vers l'Artifact Registry GCP. L'image contient le nom du projet :

```
europe-west9-docker.pkg.dev/<NOM_PROJET_GCP>/cnp-registry/cnp-portal:<tag>
```

Fichiers à mettre à jour :

| Fichier | Champ | Exemple de nouvelle valeur |
|---|---|---|
| `k8s/base/deployment.yaml` | `image:` | `europe-west9-docker.pkg.dev/<NOUVEAU_PROJET>/cnp-registry/cnp-portal:1.0.0` |
| `k8s/overlays/dev/kustomization.yaml` | `images[].newName` | `europe-west9-docker.pkg.dev/<NOUVEAU_PROJET>/cnp-registry/cnp-portal` |
| `k8s/overlays/prod/kustomization.yaml` | `images[].newName` | idem |

### 3b. Hostname de l'ingress du portail

L'ingress du portail utilise l'IP du LoadBalancer. Si l'IP change :

```bash
INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
# Nouveau hostname → cnp-portal.<INGRESS_IP>.nip.io
```

Fichiers à mettre à jour :

| Fichier | Champ |
|---|---|
| `k8s/overlays/dev/kustomization.yaml` | `patches` sur `Ingress` → `spec.rules[0].host` et `spec.tls[0].hosts[0]` |
| `k8s/overlays/prod/kustomization.yaml` | idem |

### 3c. Secrets Kubernetes du portail

Les secrets référencés dans `k8s/base/deployment.yaml` doivent être recréés sur le nouveau cluster :

```bash
# Session secret
kubectl create secret generic cnp-portal-dev-session-secret \
  -n cnp-portal \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32)

# GitLab OAuth (récupérer les valeurs depuis .env)
kubectl create secret generic cnp-portal-dev-gitlab-oauth \
  -n cnp-portal \
  --from-literal=GITLAB_CLIENT_ID=<valeur> \
  --from-literal=GITLAB_CLIENT_SECRET=<valeur> \
  --from-literal=GITLAB_REDIRECT_URI=<valeur>

# Datadog (optionnel)
kubectl create secret generic cnp-portal-dev-datadog-api-key \
  -n cnp-portal \
  --from-literal=DATADOG_API_KEY=<valeur>
```

---

## 4. Checklist de migration — résumé

```
□ Nouveau cluster GKE provisionné avec ArgoCD + nginx-ingress installés

□ ArgoCD configuré pour le portail (voir argocd-gcp-setup.md) :
    □ Mode insecure activé
    □ Ingress créé  →  http://argocd.<IP>.nip.io
    □ Compte cnp-portal créé + RBAC configuré
    □ Token API généré

□ .env mis à jour :
    □ ARGOCD_SERVER_URL=http://argocd.<IP>.nip.io
    □ ARGOCD_UI_URL=http://argocd.<IP>.nip.io
    □ ARGOCD_TOKEN=<token généré>
    □ KUBE_API_URL=https://<endpoint cluster>
    □ KUBE_TOKEN=<token SA cnp-portal>
    □ KUBE_CA_CERT=<base64 CA>

□ Si portail déployé sur le cluster :
    □ Image registry mise à jour (nouveau projet GCP)
    □ Hostname ingress mis à jour (nouvelle IP)
    □ Secrets Kubernetes recréés
    □ CI/CD mis à jour avec les nouvelles valeurs
```
