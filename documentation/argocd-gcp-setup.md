# ArgoCD — Configuration GCP / Nouveau cluster

Ce document décrit toutes les opérations à effectuer sur un nouveau cluster GKE pour que le CNP Portal puisse interagir avec ArgoCD (bouton "Ouvrir ArgoCD", liste des applications, provisioning automatique des comptes utilisateurs).

> **Prérequis** : ArgoCD doit déjà être installé sur le cluster (via Helm ou manifests). Ce document ne couvre pas l'installation d'ArgoCD elle-même.

---

## Valeurs actuelles (projet `cnp-terraform-500015`)

| Élément | Valeur |
|---|---|
| GCP Project ID | `cnp-terraform-500015` |
| GCP Project Number | `688655933459` |
| Cluster | `cnp-cluster-terraform` — zone `europe-west9-a` |
| Cluster endpoint | `https://34.163.86.239` |
| Ingress controller IP | `34.155.213.145` |
| ArgoCD URL | `http://argocd.34.155.213.145.nip.io` |
| WIF provider | `projects/688655933459/locations/global/workloadIdentityPools/github-pool/providers/github-provider` |
| GitHub CI SA | `github-ci-sa@cnp-terraform-500015.iam.gserviceaccount.com` |
| GKE node SA | `gke-nodes-sa@cnp-terraform-500015.iam.gserviceaccount.com` |
| AR registry | `europe-west9-docker.pkg.dev/cnp-terraform-500015/cnp-registry` |

---

## Ce qui est configuré et pourquoi

| Opération | Pourquoi |
|---|---|
| AppProject `platform` appliqué | Requis par tous les ApplicationSets ArgoCD |
| ingress-nginx installé via ArgoCD | Donne une IP externe LoadBalancer pour toutes les apps |
| Mode insecure sur `argocd-server` | Permet à nginx-ingress de router HTTP vers ArgoCD sans double TLS |
| Ingress ArgoCD | Expose ArgoCD publiquement via l'IP du LoadBalancer nginx |
| Compte `cnp-portal` dans ArgoCD | Service account dédié au portail (pas utiliser admin) |
| RBAC ArgoCD | Autorise `cnp-portal` à lister et syncer les apps |
| Token API permanent | Le portail s'authentifie à ArgoCD sans mot de passe |

---

## Bootstrap complet (à rejouer sur chaque nouveau cluster)

### Étape 1 — AppProject platform

```bash
kubectl apply -f config-repo/argocd/projects/default-project.yaml
```

### Étape 2 — ingress-nginx via ArgoCD

```bash
kubectl apply -f config-repo/infra/ingress-nginx/application.yaml
# Attendre l'IP externe
until kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null | grep -q '[0-9]'; do sleep 5; done
INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "INGRESS_IP=$INGRESS_IP"
```

### Étape 3 — Mode insecure ArgoCD

```bash
kubectl patch configmap argocd-cmd-params-cm -n argocd --type merge \
  -p '{"data":{"server.insecure":"true"}}'
kubectl rollout restart deployment argocd-server -n argocd
kubectl rollout status deployment argocd-server -n argocd --timeout=120s
```

### Étape 4 — Ingress ArgoCD

```bash
cat <<EOF | kubectl apply -f -
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: argocd-server
  namespace: argocd
  annotations:
    nginx.ingress.kubernetes.io/force-ssl-redirect: "false"
    nginx.ingress.kubernetes.io/backend-protocol: "HTTP"
spec:
  ingressClassName: nginx
  rules:
  - host: argocd.${INGRESS_IP}.nip.io
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: argocd-server
            port:
              number: 80
EOF
```

### Étape 5 — Compte service + RBAC cnp-portal

```bash
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"accounts.cnp-portal":"apiKey"}}'

kubectl patch configmap argocd-rbac-cm -n argocd --type merge \
  -p '{
    "data": {
      "policy.csv": "p, role:portal, applications, get, */*, allow\np, role:portal, applications, sync, */*, allow\ng, cnp-portal, role:portal\n",
      "policy.default": "role:readonly"
    }
  }'
```

### Étape 6 — Token API permanent

```bash
ARGOCD_URL="http://argocd.${INGRESS_IP}.nip.io"

# Attendre que ArgoCD réponde
until curl -s -o /dev/null -w "%{http_code}" "$ARGOCD_URL/healthz" | grep -q "200"; do sleep 3; done

# Mot de passe admin initial
ARGOCD_PASS=$(kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 -d)

# Token admin temporaire
ADMIN_TOKEN=$(curl -s -X POST "$ARGOCD_URL/api/v1/session" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$ARGOCD_PASS\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Token permanent pour cnp-portal
PORTAL_TOKEN=$(curl -s -X POST "$ARGOCD_URL/api/v1/account/cnp-portal/token" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"portal-token"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "=== Copier dans .env ==="
echo "ARGOCD_SERVER_URL=$ARGOCD_URL"
echo "ARGOCD_UI_URL=$ARGOCD_URL"
echo "ARGOCD_TOKEN=$PORTAL_TOKEN"
```

### Étape 7 — Crossplane (si Cloud Run utilisé)

```bash
kubectl apply -f config-repo/infra/crossplane/application.yaml
```

---

## Vérification

```bash
# UI accessible
curl -s -o /dev/null -w "%{http_code}" "$ARGOCD_URL/"
# → 200

# Token portail peut lister les apps
curl -s "$ARGOCD_URL/api/v1/applications" \
  -H "Authorization: Bearer $PORTAL_TOKEN" \
  | python3 -c "import sys,json; apps=json.load(sys.stdin).get('items',[]); print(len(apps),'apps')"
```

---

## Option Terraform (recommandé pour automatisation)

Ajouter ce bloc dans la configuration Terraform après la création du cluster :

```hcl
variable "argocd_admin_password" {
  type      = string
  sensitive = true
}
variable "ingress_ip" {
  type = string
}

locals {
  argocd_host   = "argocd.${var.ingress_ip}.nip.io"
  argocd_ui_url = "http://${local.argocd_host}"
}

resource "kubernetes_config_map_v1_data" "argocd_insecure" {
  metadata { name = "argocd-cmd-params-cm"; namespace = "argocd" }
  data  = { "server.insecure" = "true" }
  force = false
}

resource "null_resource" "restart_argocd" {
  depends_on = [kubernetes_config_map_v1_data.argocd_insecure]
  provisioner "local-exec" {
    command = "kubectl rollout restart deployment argocd-server -n argocd && kubectl rollout status deployment argocd-server -n argocd --timeout=120s"
  }
}

resource "kubernetes_ingress_v1" "argocd" {
  depends_on = [null_resource.restart_argocd]
  metadata {
    name      = "argocd-server"
    namespace = "argocd"
    annotations = {
      "nginx.ingress.kubernetes.io/force-ssl-redirect" = "false"
      "nginx.ingress.kubernetes.io/backend-protocol"   = "HTTP"
    }
  }
  spec {
    ingress_class_name = "nginx"
    rule {
      host = local.argocd_host
      http {
        path {
          path      = "/"
          path_type = "Prefix"
          backend { service { name = "argocd-server"; port { number = 80 } } }
        }
      }
    }
  }
}

resource "kubernetes_config_map_v1_data" "argocd_portal_account" {
  metadata { name = "argocd-cm"; namespace = "argocd" }
  data  = { "accounts.cnp-portal" = "apiKey" }
  force = false
}

resource "kubernetes_config_map_v1_data" "argocd_rbac" {
  metadata { name = "argocd-rbac-cm"; namespace = "argocd" }
  data = {
    "policy.csv"     = "p, role:portal, applications, get, */*, allow\np, role:portal, applications, sync, */*, allow\ng, cnp-portal, role:portal\n"
    "policy.default" = "role:readonly"
  }
  force = false
}

resource "null_resource" "argocd_portal_token" {
  depends_on = [kubernetes_config_map_v1_data.argocd_portal_account, kubernetes_ingress_v1.argocd]
  provisioner "local-exec" {
    command = <<-EOT
      URL="${local.argocd_ui_url}"
      until curl -s -o /dev/null -w "%{http_code}" "$URL/healthz" | grep -q "200"; do sleep 3; done
      ADMIN_TOKEN=$(curl -s -X POST "$URL/api/v1/session" \
        -H "Content-Type: application/json" \
        -d '{"username":"admin","password":"${var.argocd_admin_password}"}' \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
      API_TOKEN=$(curl -s -X POST "$URL/api/v1/account/cnp-portal/token" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"portal-token"}' \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
      echo "$API_TOKEN" > /tmp/argocd_portal_token.txt
    EOT
  }
}

output "argocd_ui_url" { value = local.argocd_ui_url }
output "argocd_token_path" { value = "/tmp/argocd_portal_token.txt" }
```

---

## RBAC Kubernetes requis pour le provisioning des comptes utilisateurs

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: cnp-portal-argocd-provisioner
  namespace: argocd
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["argocd-cm"]
  verbs: ["get", "patch"]
- apiGroups: [""]
  resources: ["secrets"]
  resourceNames: ["argocd-secret"]
  verbs: ["get", "patch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: cnp-portal-argocd-provisioner
  namespace: argocd
subjects:
- kind: ServiceAccount
  name: cnp-portal
  namespace: cnp-portal
roleRef:
  kind: Role
  name: cnp-portal-argocd-provisioner
  apiGroup: rbac.authorization.k8s.io
```
