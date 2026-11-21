# Cloud deployment paths

Portal deployment and common production checks are in
[Platform/DEPLOYMENT.md](../Platform/DEPLOYMENT.md). This folder contains only
instructions specific to a supported application runtime.

| Path | Use |
|---|---|
| [GCP](GCP/README.md) | Cloud Run with SQLite or PostgreSQL |
| [Azure](Azure/README.md) | Container Apps with PostgreSQL |
| [AWS failover](AWS-Failover/README.md) | Recovery path for eligible GCP PostgreSQL production apps |
| [Private k3s](Private-K3s/README.md) | Applications hosted in the private cluster |
