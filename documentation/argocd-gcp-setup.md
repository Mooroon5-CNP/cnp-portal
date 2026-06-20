# ArgoCD — Configuration GCP / Nouveau cluster

Ce document décrit toutes les opérations à effectuer sur un nouveau cluster GKE pour que le CNP Portal puisse interagir avec ArgoCD (bouton "Ouvrir ArgoCD", liste des applications, provisioning automatique des comptes utilisateurs).

> **Prérequis** : ArgoCD doit déjà être installé sur le cluster (via Helm ou manifests). Ce document ne couvre pas l'installation d'ArgoCD elle-même.

---

## Ce qui est configuré et pourquoi

| Opération | Pourquoi |
|---|---|
| Mode insecure sur `argocd-server` | Permet à nginx-ingress de router HTTP vers ArgoCD sans TLS double-couche |
| Ingress ArgoCD | Expose ArgoCD publiquement via l'IP du LoadBalancer nginx |
| Compte `cnp-portal` dans ArgoCD | Service account dédié au portail (pas utiliser admin) |
| RBAC ArgoCD | Autorise `cnp-portal` à lister et syncer les apps |
| Token API permanent | Le portail s'authentifie à ArgoCD sans mot de passe |

---

## Option A — Terraform (recommandé)

Ajouter ce bloc dans votre configuration Terraform existante (provider `kubernetes` et `helm` déjà configurés sur le cluster cible).

### `argocd_portal_config.tf`

```hcl
# ─────────────────────────────────────────────────────────────
# Variables
# ─────────────────────────────────────────────────────────────

variable "argocd_admin_password" {
  description = "Mot de passe de l'admin ArgoCD (disponible dans le Secret argocd-initial-admin-secret)"
  type        = string
  sensitive   = true
}

variable "ingress_ip" {
  description = "IP externe du LoadBalancer nginx-ingress (récupérée via kubectl get svc -n ingress-nginx)"
  type        = string
}

# ─────────────────────────────────────────────────────────────
# 1. Mode insecure — argocd-cmd-params-cm
# ─────────────────────────────────────────────────────────────

resource "kubernetes_config_map_v1_data" "argocd_insecure_mode" {
  metadata {
    name      = "argocd-cmd-params-cm"
    namespace = "argocd"
  }

  data = {
    "server.insecure" = "true"
  }

  # Ne remplace pas les autres clés existantes du ConfigMap
  force = false
}

# Redémarrer argocd-server pour prendre en compte le mode insecure
resource "null_resource" "restart_argocd_server" {
  depends_on = [kubernetes_config_map_v1_data.argocd_insecure_mode]

  triggers = {
    config_hash = kubernetes_config_map_v1_data.argocd_insecure_mode.id
  }

  provisioner "local-exec" {
    command = "kubectl rollout restart deployment argocd-server -n argocd && kubectl rollout status deployment argocd-server -n argocd --timeout=120s"
  }
}

# ─────────────────────────────────────────────────────────────
# 2. Ingress ArgoCD
# ─────────────────────────────────────────────────────────────

locals {
  argocd_host   = "argocd.${var.ingress_ip}.nip.io"
  argocd_ui_url = "http://${local.argocd_host}"
}

resource "kubernetes_ingress_v1" "argocd_server" {
  depends_on = [null_resource.restart_argocd_server]

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
          backend {
            service {
              name = "argocd-server"
              port { number = 80 }
            }
          }
        }
      }
    }
  }
}

# ─────────────────────────────────────────────────────────────
# 3. Compte service cnp-portal dans argocd-cm
# ─────────────────────────────────────────────────────────────

resource "kubernetes_config_map_v1_data" "argocd_portal_account" {
  metadata {
    name      = "argocd-cm"
    namespace = "argocd"
  }

  data = {
    "accounts.cnp-portal" = "apiKey"
  }

  force = false
}

# ─────────────────────────────────────────────────────────────
# 4. RBAC — argocd-rbac-cm
# ─────────────────────────────────────────────────────────────

resource "kubernetes_config_map_v1_data" "argocd_rbac" {
  metadata {
    name      = "argocd-rbac-cm"
    namespace = "argocd"
  }

  data = {
    "policy.csv"     = <<-EOT
      p, role:portal, applications, get,  */*, allow
      p, role:portal, applications, sync, */*, allow
      g, cnp-portal, role:portal
    EOT
    "policy.default" = "role:readonly"
  }

  force = false
}

# ─────────────────────────────────────────────────────────────
# 5. Token API permanent pour cnp-portal
#    Résultat écrit dans /tmp/argocd_portal_token.txt
# ─────────────────────────────────────────────────────────────

resource "null_resource" "argocd_portal_token" {
  depends_on = [
    kubernetes_config_map_v1_data.argocd_portal_account,
    kubernetes_ingress_v1.argocd_server,
  ]

  triggers = {
    argocd_host   = local.argocd_host
    account_hash  = kubernetes_config_map_v1_data.argocd_portal_account.id
  }

  provisioner "local-exec" {
    command = <<-EOT
      set -e
      URL="${local.argocd_ui_url}"

      # Attendre que le serveur ArgoCD réponde
      for i in $(seq 1 20); do
        STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$URL/healthz" 2>/dev/null || echo 0)
        [ "$STATUS" = "200" ] && break
        echo "Waiting for ArgoCD... ($i/20)"
        sleep 5
      done

      # Session admin (token temporaire 24h)
      ADMIN_TOKEN=$(curl -s -X POST "$URL/api/v1/session" \
        -H "Content-Type: application/json" \
        -d '{"username":"admin","password":"${var.argocd_admin_password}"}' \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

      # Token permanent pour cnp-portal
      API_TOKEN=$(curl -s -X POST "$URL/api/v1/account/cnp-portal/token" \
        -H "Authorization: Bearer $ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d '{"name":"portal-token"}' \
        | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

      echo "$API_TOKEN" > /tmp/argocd_portal_token.txt
      echo "✓ Token écrit dans /tmp/argocd_portal_token.txt"
      echo "  À copier dans ARGOCD_TOKEN= de votre .env"
    EOT
  }
}

# ─────────────────────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────────────────────

output "argocd_ui_url" {
  description = "URL publique d'ArgoCD à mettre dans ARGOCD_UI_URL et ARGOCD_SERVER_URL"
  value       = local.argocd_ui_url
}

output "argocd_token_path" {
  description = "Fichier contenant le token API à copier dans ARGOCD_TOKEN"
  value       = "/tmp/argocd_portal_token.txt"
}
```

### Utilisation

```bash
# Récupérer l'IP du LoadBalancer nginx
INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

# Récupérer le mot de passe admin ArgoCD initial
ARGOCD_PASS=$(kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 -d)

terraform apply \
  -var="ingress_ip=$INGRESS_IP" \
  -var="argocd_admin_password=$ARGOCD_PASS"

# Récupérer le token généré
ARGOCD_TOKEN=$(cat /tmp/argocd_portal_token.txt)
echo "ARGOCD_TOKEN=$ARGOCD_TOKEN"
```

Puis mettre à jour le `.env` du portail (voir section [Variables à mettre à jour](#variables-à-mettre-à-jour-dans-env)).

---

## Option B — Kubectl (manuel)

Si Terraform n'est pas disponible, exécuter les commandes suivantes dans l'ordre.

### 1. Récupérer les infos du cluster

```bash
# IP du LoadBalancer nginx (ingress controller)
INGRESS_IP=$(kubectl get svc ingress-nginx-controller -n ingress-nginx \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "INGRESS_IP=$INGRESS_IP"

# Mot de passe admin ArgoCD initial
ARGOCD_PASS=$(kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 -d)
echo "ARGOCD_PASS=$ARGOCD_PASS"

# URL ArgoCD (dérivée de l'IP)
ARGOCD_URL="http://argocd.${INGRESS_IP}.nip.io"
echo "ARGOCD_URL=$ARGOCD_URL"
```

### 2. Mode insecure sur argocd-server

```bash
kubectl patch configmap argocd-cmd-params-cm -n argocd \
  --type merge \
  -p '{"data":{"server.insecure":"true"}}'

kubectl rollout restart deployment argocd-server -n argocd
kubectl rollout status deployment argocd-server -n argocd --timeout=120s
```

### 3. Ingress ArgoCD

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

### 4. Compte service cnp-portal

```bash
kubectl patch configmap argocd-cm -n argocd \
  --type merge \
  -p '{"data":{"accounts.cnp-portal":"apiKey"}}'
```

### 5. RBAC pour cnp-portal

```bash
kubectl patch configmap argocd-rbac-cm -n argocd \
  --type merge \
  -p '{
    "data": {
      "policy.csv": "p, role:portal, applications, get, */*, allow\np, role:portal, applications, sync, */*, allow\ng, cnp-portal, role:portal\n",
      "policy.default": "role:readonly"
    }
  }'
```

### 6. Générer le token API permanent

```bash
# Session admin (expire dans 24h — juste pour générer le token permanent)
ADMIN_TOKEN=$(curl -s -X POST "$ARGOCD_URL/api/v1/session" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$ARGOCD_PASS\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

# Token permanent sans expiration pour cnp-portal
PORTAL_TOKEN=$(curl -s -X POST "$ARGOCD_URL/api/v1/account/cnp-portal/token" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"portal-token"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")

echo "ARGOCD_TOKEN=$PORTAL_TOKEN"
```

---

## Variables à mettre à jour dans `.env`

Après avoir exécuté l'option A ou B, mettre à jour ces 3 variables dans `.env` :

```bash
# Remplacer X.X.X.X par l'IP réelle du LoadBalancer nginx
ARGOCD_SERVER_URL=http://argocd.X.X.X.X.nip.io
ARGOCD_UI_URL=http://argocd.X.X.X.X.nip.io
ARGOCD_TOKEN=<token généré à l'étape 6>
```

---

## Vérification

```bash
# 1. L'UI ArgoCD répond
curl -s -o /dev/null -w "%{http_code}" "$ARGOCD_URL/"
# Attendu : 200

# 2. Le token portail peut lister les apps
curl -s "$ARGOCD_URL/api/v1/applications" \
  -H "Authorization: Bearer $PORTAL_TOKEN" \
  | python3 -c "import sys,json; apps=json.load(sys.stdin).get('items',[]); print(len(apps),'apps')"
```

---

## RBAC Kubernetes requis pour le provisioning des comptes utilisateurs

Lorsqu'un manager approuve une demande d'accès ArgoCD depuis le portail, celui-ci patche automatiquement `argocd-cm` et `argocd-secret`. Le service account Kubernetes du portail (`KUBE_TOKEN`) doit avoir ces permissions dans le namespace `argocd` :

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
  name: <nom-du-sa-du-portail>
  namespace: cnp-portal
roleRef:
  kind: Role
  name: cnp-portal-argocd-provisioner
  apiGroup: rbac.authorization.k8s.io
```

Si cette permission est absente, le provisioning échoue silencieusement (erreur loguée) mais les credentials générés sont quand même affichés dans le portail.
