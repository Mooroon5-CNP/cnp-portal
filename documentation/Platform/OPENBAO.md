# OpenBao

OpenBao stores versioned application variables. The portal writes them; each
application runtime receives only its own values for its environment.

| Runtime | Variable delivery |
|---|---|
| GCP Cloud Run | Google Secret Manager |
| Azure Container Apps | Azure Key Vault |
| AWS ECS failover | AWS Secrets Manager |
| Private k3s | External Secrets Operator and Kubernetes Secret references |

The portal's OpenBao identity is separate from each application's runtime
identity. An endpoint health check confirms TLS and availability only. To
verify variable delivery, create a disposable application through the portal
and check its runtime. The exact production checks are in the
[platform runbook](DEPLOYMENT.md).
