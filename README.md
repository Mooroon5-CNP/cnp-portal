# CNP Portal

Internal Developer Platform for deploying GitHub applications through CI,
Argo CD and Crossplane, with a read-only MCP assistant.

## Start CNP Portal + MCP

Use Node.js **22 or later** (the Docker image uses Node 22). Keep the repositories
next to each other: `CNP/cnp-portal` and `CNP/MCP-CNP`.

Install dependencies and build MCP once, starting from `cnp-portal`:

```bash
cd ../MCP-CNP
npm ci
npm run build
cd ../cnp-portal
npm ci
```

Create `.env` from [.env.example](.env.example) if it does not exist, then configure
GitHub, Argo CD, Kubernetes and Datadog as needed. Keep existing `.env` and
`.env.cloud` files. See the [MCP guide](documentation/MCP_INTEGRATION.md) for details.

Start both services from `cnp-portal`:

```bash
npm run dev:integration
```

Open **http://localhost:3001/mcp-chat** and sign in. The portal uses port **3001**
and MCP uses port **3000**; both ports must be free. **Ctrl+C** stops both.
The launcher uses real sources; unavailable sources do not fall back to mock data.

If MCP-CNP is located elsewhere:

```bash
MCP_PROJECT_DIR=/path/to/MCP-CNP npm run dev:integration
```

Other modes:

```bash
npm start                       # Portal only; default port 3000, configurable with PORT
npm run dev                     # Portal only, with automatic reload
npm run dev:integration:mock     # Portal + MCP with synthetic data
```

The default MCP client mode is `fake`. Use `dev:integration` for a real MCP
connection. Portal startup also runs deployment and failover reconcilers against
the configured database and cloud services.

## Sign in and roles

Sign in with a local account or GitHub OAuth. New GitHub users need manager approval.
On a fresh database, the local username is `admin`. Its password comes from
`ADMIN_INITIAL_PASSWORD` (16–72 bytes) or is generated and saved in
`data/admin-initial-password`, beside the database. An existing account keeps its
password, except that the legacy `admin` password is migrated by default.

| Role | Main capabilities |
| --- | --- |
| `dev` | Deploy, inspect accessible apps and request deletion |
| `devops` | Dev capabilities, cloud selection, Kubernetes operations and manifest editing |
| `manager` | User and team access management, production approvals and deletion |

## Deploy an application

1. Choose a GitHub repository, application name, port, team and environment (`dev` or `prod`).
2. Choose hosting and data: Azure with PostgreSQL, GCP with SQLite storage, or GCP with PostgreSQL.
3. The portal configures CI for `main` (dev) and `prod` (production).
4. Successful dev CI publishes automatically. Production requires manager approval.
5. Argo CD and Crossplane reconcile the environment; the portal checks runtime and routing readiness.

GCP PostgreSQL uses Cloud SQL in dev. In production, that choice requests the
GCP-to-AWS failover setup, with manager confirmation. Azure and failover require
their infrastructure and credentials to be configured.

GCP public names default to `<app>.dev.apps.mooroon5.fr` and
`<app>.apps.mooroon5.fr`, configurable with `APPLICATIONS_BASE_DOMAIN`.
DNS, certificates and cloud permissions must be ready.

See [deployment details](documentation/Cloud/DEPLOYMENT_ENVIRONMENTS.md),
[cloud setup](documentation/Cloud/README.md) and
[failover configuration](documentation/Cloud/FAILOVER-CONFIGURATION.md).

## MCP assistant

The assistant provides read-only application, deployment, log and FinOps queries.
Try `/applications`, `/deploiement`, `/logs` or `/finops` in the chat.
Results depend on configured sources and can be partial or unavailable.

Portal queries are filtered by the user's application and environment access.
Logs need Datadog credentials; FinOps recommendations need metrics. Optional
`GENAI_*` settings enable generated summaries and application-name resolution.
`TYPESAFE_*` settings enable Jev routing for ambiguous requests.

See the [MCP integration guide](documentation/MCP_INTEGRATION.md) for configuration,
source requirements and troubleshooting.

## Per-application observability

The deployment detail page has an Observabilité tab with application-scoped Datadog
logs, metrics, Kubernetes usage by environment, and alerts. Users with the relevant
permissions can silence or reactivate alerts. The page still renders when Datadog
is unavailable; missing metrics appear as unavailable values.

## Configuration and persistence

| Setting | Purpose |
| --- | --- |
| `.env` | Portal, GitHub, session and optional AI/Datadog settings |
| `.env.cloud` | Imported cloud settings; override with `CLOUD_ENV_FILE` |
| `DB_PATH` | SQLite file; defaults to `data/cnp-portal.sqlite` |
| `DATA_DIR` | Alternative default database directory |
| `ADMIN_INITIAL_PASSWORD` | Initial local admin password |
| `SESSION_SECRET` | At least 32 bytes; otherwise a new secret is generated at startup |
| `MCP_PROJECT_DIR` | Path to the built MCP-CNP checkout |
| `GENAI_ENABLED`, `GENAI_API_KEY`, `GENAI_MODEL` | Optional answer generation |
| `MCP_ROUTING_MODE` | `local`, `hybrid` (default in the launcher), or `jev` |

Keep SQLite persistent for deployment and release recovery. Restarting with a
generated session secret invalidates existing sessions. Cloud and IAM setup is
described in the [cloud README](documentation/Cloud/README.md).

## Checks

From `cnp-portal`:

```bash
npm run lint
npm test -- --runInBand
npm run test:generation
npm run test:context
npm run test:integration
```

The integration check requires a built MCP-CNP checkout, OpenSSL and the Python
environment described in the [Platform API README](services/platform-api/README.md).
Generation and context checks simulate model responses.

For configured live sources:

```bash
npm run test:live-sources
npm run test:live-environments -- <application-id>
```

Portal health endpoints are `/healthz` and `/ready`.

## Repository layout

- `src/`: Express portal, authentication, SQLite and deployment services.
- `apps/orchestrator/`: MCP chat, routing, source adapters and authorized context.
- `packages/contracts/`: Tool and event contracts.
- `public/`: Browser scripts and static assets.
- `scripts/`: Local startup, checks, cloud helpers and failover engine.
- `services/platform-api/`: Separate read-only API with fixture catalog data.
- `documentation/`: Architecture, setup guides and historical verification notes.

The MCP server lives in the separate `MCP-CNP` repository.
