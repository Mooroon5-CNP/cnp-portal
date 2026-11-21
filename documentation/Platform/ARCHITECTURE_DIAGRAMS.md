# CNP architecture and service catalogue

The [cloud landscape](../architecture/diagrams/cloud-landscape.dark.png) shows the portal,
delivery chain and four runtime paths. The [OpenBao view](../architecture/diagrams/openbao-four-clouds.dark.png)
uses the same four columns for every target: version store, runtime identity,
delivery and application. The [service catalogue](../architecture/diagrams/service-catalog.dark.png)
lists what an application team can request today. Each PNG also has a light
variant and an editable `.drawio` file in `diagrams/`.

| Service offered through the portal | Runtime and scope |
| --- | --- |
| GCP SQLite application | Cloud Run, persistent files in GCS, dev or prod |
| GCP PostgreSQL application | Cloud Run and Cloud SQL, dev or prod; eligible production includes AWS ECS/RDS failover |
| Azure PostgreSQL application | Container Apps and private Flexible Server, dev or prod |
| Private Kubernetes application | AWS-hosted k3s and in-cluster PostgreSQL, dev or prod |
| Versioned application variables | OpenBao KV v2 with a separate per-target delivery mechanism |
| Application observability | Datadog metrics and logs surfaced by the portal |

The real remote MCP-CNP service is a later promotion. The existing portal MCP UI
and code remain present. AWS failover is part of eligible GCP PostgreSQL
production; it is not a standalone generic AWS deployment target.

## Rebuild the diagrams

The source of truth is `cnp-platform/model.yaml` plus one YAML file per view.
Use the project's checked-in icons in `.noodle/icons`. From this directory:

```sh
NOODLE=/path/to/noodle
S=cnp-platform
I=.noodle/icons
for V in cloud-landscape openbao-four-clouds service-catalog; do
  "$NOODLE" render "$S" -view "$V" -icons "$I"
  for T in dark light; do
    "$NOODLE" render "$S" -view "$V" -icons "$I" -theme "$T" -o "diagrams/$V.$T.drawio"
    drawio -x -f png -s 1.6 --border 20 -o "diagrams/$V.$T.png" "diagrams/$V.$T.drawio"
  done
done
```

The first render runs Noodle's checks without writing. The PNG export uses
scale 1.6 to stay below draw.io's wide-canvas crop limit. Regenerate both
themes after editing the model or a view; do not hand-edit generated `.drawio`.

Facts come from `cnp-portal` deployment manifests, variable delivery code and
the `cnp/cluster` Terraform/Kubernetes configuration as inspected on 21
November 2026. Live readiness is governed by the
[production runbook](DEPLOYMENT.md), not by a diagram.
The legacy GCP `11-vault.tf` installs HashiCorp Vault with TLS disabled; it is
not the GCP OpenBao endpoint configured in the portal. The OpenBao GCP bootstrap
source needs a separate trace before treating its installation as reproducible.
