# CNP Portal

Internal Developer Platform for deploying GitHub applications to GCP Cloud Run
through CI, Argo CD and Crossplane, with a read-only MCP assistant.

## Current status

The dev/prod deployment feature is merged into `main`. The latest MCP fixes are
committed locally on **`feat/mcp-environment-integration`**; they are not yet
pushed or merged. The original `feat/MCPapi` checkout does not contain these fixes.

| Feature | What works | Requirement or limit |
| --- | --- | --- |
| App deployments | Select dev or prod; separate services and optional storage | Configured GCP/GitHub/Argo access |
| Dev publication | App `main` → successful CI → automatic publication | Running portal reconciler |
| Production publication | App `prod` → successful CI → manager approval in portal | GitHub App merges the approved candidate |
| MCP `/applications` | Lists apps and environments accessible to the user | Real-source integration launcher |
| MCP `/deploiement` | Desired and observed serving versions for dev/prod | Git, Argo and Kubernetes/Crossplane access |
| MCP permissions | Dev-only portal access cannot query prod | Standalone MCP server authorization is still future work |
| MCP `/logs` | Read-only, bounded, redacted logs | Datadog credentials and matching service/environment tags |
| MCP `/finops` | Single-app utilization recommendations or explicit insufficient-data result | Metrics required; actual costs remain `null` |
| AI summaries and app descriptions | Optional generation and semantic resolution | Server-side `GENAI_*` configuration |
| Team FinOps and real billing | Specified, not implemented | Versioned contracts, authorization and billing source needed |

Live read-only verification on **26 October 2026** passed real portal login,
CSRF, SSE, MCP HTTP and Pixel Cam dev/prod serving-version checks. Argo reported
`OutOfSync/Degraded`, so results were correctly **partial**. This is not proof
that custom domains, Route53 failover, Datadog or billing are working.

## Start the portal with the MCP assistant

Use Node.js **24** for the tested setup; MCP-CNP requires Node.js 22 or later.
The repositories are normally siblings: `CNP/cnp-portal` and `CNP/MCP-CNP`.

Install dependencies once in each checkout if they are missing, then build MCP:

```bash
cd ../MCP-CNP
npm ci
npm run build
cd ../cnp-portal
npm ci
```

Create `.env` from `.env.example` only if absent, and configure the real sources.
Keep an existing `.env` and `.env.cloud`; never overwrite credentials as part of
setup. See the [MCP guide](documentation/MCP_INTEGRATION.md) for configuration.

From a normal portal checkout containing the latest MCP changes:

```bash
npm run dev:integration
```

Open **http://localhost:3001/mcp-chat**. The launcher starts MCP on
`127.0.0.1:3000`, checks its authenticated catalog, and starts the portal on 3001.
It refreshes local JWTs on calls. Ctrl+C stops both child services. If a port is
occupied, the launcher stops; it does not terminate another process.

In the current isolated MCP worktree, use the worktree startup instructions in
[the guide](documentation/MCP_INTEGRATION.md#démarrer-la-branche-isolée-actuelle).
Set `MCP_PROJECT_DIR` explicitly there: the sibling-path default does not point
to the MCP repository from a nested worktree.

Other modes:

```bash
npm start                       # Portal only; does not start an MCP server
npm run dev:integration:mock     # Explicit synthetic integration demo
```

The checked-in MCP client default is `fake`; `npm start` alone is not a live MCP
integration. The real-source launcher supplies the HTTP client configuration.
Normal portal startup also runs the deployment reconciler against its configured
DB/cloud; the chat tools themselves remain read-only.

## Deploy an application

1. Submit the repository, application name, port, environment and storage choice.
2. The portal checks access and the environment's Argo project, configures CI
   credentials and installs the app-specific workflow for `main` and `prod`.
3. CI builds the image and runs lint, tests and security scans. A failed pipeline
   publishes no environment manifests.
4. Successful dev CI publishes automatically. Successful prod CI creates a
   candidate; a manager approves or rejects it in the portal.
5. Scoped Argo ApplicationSets reconcile the selected environment through
   Crossplane. Storage and its access binding become healthy before Cloud Run.
6. The portal waits for the expected runtime image and verified HTTPS routing
   before showing the application as available.

Environment paths are `apps/<app>/crossplane/dev/` and `prod/`. Runtime names
are `<app>-dev` and `<app>-prod`; image names remain `<registry>/<app>:<SHA>`.
The public names are `<app>.dev.apps.mooroon5.fr` and `<app>.apps.mooroon5.fr`
(or the configured `APPLICATIONS_BASE_DOMAIN`). DNS, certificates and load
balancer permissions must be ready; constructing a name does not enable it.

Historical deployments keep their original paths. Deletion of a new deployment
removes only the chosen environment and retains its sibling's shared CI setup.
Storage cleanup is subject to the bucket's deletion policy and contents.

See [deployment details](documentation/Cloud/DEPLOYMENT_ENVIRONMENTS.md),
[cloud setup and migration](documentation/Cloud/README.md), and
[recorded infrastructure changes](documentation/Cloud/UpdatedCloudThings.md).

## Authentication and roles

Local password and GitHub OAuth login use portal sessions. SQLite stores users,
teams, deployments and release decisions. The default local account is
`admin` / `admin`; change it before shared use.

| Role | Main capabilities |
| --- | --- |
| `dev` | Deploy and inspect accessible apps; request deletion |
| `devops` | Dev capabilities, manifest editing and team access management |
| `manager` | User/role management, deletion and production approvals |

MCP catalog entries and targeted calls are filtered by the current user's
application **and environment** access. The model cannot grant permissions.
For shared MCP exposure, independent server-side authorization remains required;
a JWT with the global read scope alone is not an app/environment access policy.

## Configuration and persistence

- `.env`: portal/GitHub credentials, session settings and optional AI/Datadog config.
- `.env.cloud`: imported cloud connection settings; `CLOUD_ENV_FILE` selects another file.
- `DB_PATH`: SQLite location, otherwise `data/cnp-portal.sqlite` in the checkout.
- `MCP_PROJECT_DIR`: MCP-CNP checkout containing the built runtime.
- `GENAI_ENABLED`, `GENAI_API_KEY`, `GENAI_MODEL`: optional summaries/app resolution.
- `TYPESAFE_*`: optional Jev routing for ambiguous free text; slash commands work without it.

Keep the database durable for release reconciliation and restart recovery. Running
from a different worktree without `DB_PATH` can create another database. The local
launcher is not a shared-hosting deployment strategy. Infrastructure and IAM
changes belong in Terraform/GitOps or the cloud runbook, including migration and
rollback instructions. No project/account migration happens automatically.

## Validation

From the portal checkout:

```bash
npm run lint
npm test -- --runInBand
npm run test:generation
npm run test:context
npm run test:integration
npm run test:live-environments -- app4-pixelcam
```

The cross-repository integration test needs a built MCP checkout and the existing
Platform API test Python environment. The live recipe needs real source access;
it uses an isolated temporary DB, performs no cloud writes and makes no paid AI
calls. SDK generation/context tests simulate model responses.

Verified on 26 October: **151 portal tests**, **58 MCP tests**, lint/type checks,
synthetic cross-repository integration, and the live dev/prod recipe passed.
These results apply to the documented revisions, not every future configuration.
Unauthenticated health endpoints are `/healthz` and `/ready`.

## Code and specifications

- `src/`: Express, sessions/RBAC, SQLite, cloud clients, deployment lifecycle and views.
- `apps/orchestrator/`: MCP chat, conversation, authorized context and native adapters.
- `packages/contracts/`: portal-side tool and SSE contracts.
- `public/js/`: chat interaction and structured result rendering.
- `scripts/`: local launcher, verification commands and cloud setup helpers.
- `MCP-CNP/specs/`: six specifications for full functionality in the sibling repository.

Full MCP configuration, troubleshooting and remaining work:
[MCP integration guide](documentation/MCP_INTEGRATION.md).
