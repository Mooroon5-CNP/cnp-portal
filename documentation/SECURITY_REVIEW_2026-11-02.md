# Local portal + MCP security review — 2026-11-02

Scope: existing integration branches, read-only MCP, local combined launcher.
This record supersedes the earlier dependency-install blocker for local testing:
dependencies became available during the review. npm audit remains unreachable.
No cloud mutation, live AI call, deployment or publication was performed.

## Fixed

- `/profile/role` required only login and accepted `manager`: now manager-only.
- Database bootstrap no longer creates admin/admin. A fresh database or an existing
  admin with that default hash requires ADMIN_INITIAL_PASSWORD (16–72 bytes).
  Existing custom admin passwords are preserved. A random bootstrap password was
  added privately to the local portal .env; it is not committed or printed.
- Local and GitHub login regenerate and save the session before proceeding;
  deleted-user sessions lose their stale identity and cannot enter protected routes.
- Local password login is bounded to 20 attempts/address/15 minutes; memory is capped.
- SameSite=Lax cookies and browser Origin/Referer/Fetch-Metadata checks protect
  writes; GET logout now returns 405. Existing MCP session CSRF tokens remain required.
  Non-browser requests without browser headers still require route authentication;
  the browser guard is not a general replacement for per-route authorization.
- Local portal binding defaults to 127.0.0.1, and the combined launcher forces it.
  Local requests no longer trust proxy-supplied client addresses.
- Production requires a configured session key >=32 bytes. Missing/known placeholder
  local keys use fresh random material, never a public fallback. Argo credential
  encryption uses the same session-key configuration. Without a stable local key,
  sessions and locally encrypted Argo credentials cannot survive restart; set a
  random SESSION_SECRET before provisioning credentials.
- Global TLS verification bypass is refused by portal and native launchers;
  production Argo requests refuse ARGOCD_INSECURE=true.
- Canonical documentation paths enforce directory boundaries and DevOps classification,
  including dot segments and symlinks. Markdown escapes raw HTML and rejects executable
  URL protocols; a documentation CSP also blocks scripts. Normal Markdown links/headings
  remain supported; embedded raw HTML is displayed as text.
- MCP CSRF byte lengths are compared safely for multibyte headers.
- The existing Argo hardening patch a1c26bb was integrated (local commit b42e0b5),
  preserving MCP getApplicationDetails. Platform applications cannot be synced;
  shared ApplicationSets cannot be deleted. The Azure mock was updated accordingly.
- MCP authenticated HTTP requests are limited across initialization/discovery as well
  as tool calls; excess requests return 429 with Retry-After.

## Validation

Node 26.13.0 available here; Node 24 remains the documented runtime baseline.

| Check | Result |
| --- | --- |
| Portal lint | Passed |
| Portal tests without listener-dependent suites | 180 passed, 26 suites |
| Portal generation/context harnesses | Passed; API responses simulated, no paid call |
| MCP typecheck/lint/build | Passed |
| MCP tests without the listener-dependent HTTP client case | 58 passed, 1 explicitly excluded |
| MCP schema generation | Passed via node --import tsx; no schema changes |
| Full HTTP suites | Blocked by sandbox listen EPERM; not a functional pass |
| npm audit, both repos | EAI_AGAIN resolving registry.npmjs.org; no vulnerability count available |

Portal rerun command in this environment:

```bash
npm test -- --runInBand --testPathIgnorePatterns='deployment-environment-routes|azure-route|index.test|mcp-user-access'
```

MCP rerun command in this environment:

```bash
npm test -- --testNamePattern='^(?!.*is called by the production MCP HTTP client)'
```

Run the full existing suites in an environment allowing local listeners before merging.

## Still open — no claim of zero vulnerabilities

1. Re-run npm audit in both repositories with registry access. Dependency locks were
   not hand-edited or upgraded without registry metadata and compatibility checks.
2. The portal lock includes @kubernetes/client-node 0.20.0 → request 2.88.2 →
   tough-cookie 2.5.0. The latter is in the affected range for
   [GHSA-72xf-g2v4-qvf3](https://github.com/advisories/GHSA-72xf-g2v4-qvf3).
   This remains unresolved. The Kubernetes client switches HTTP backend at 1.0
   and also becomes ESM; replacing it requires an API/module migration and source tests,
   not an unchecked cross-major transitive override. See the
   [upstream release notes](https://github.com/kubernetes-client/javascript/releases).
3. SPEC-02 trusted per-user application/environment authorization and cursor binding
   remain absent at the direct MCP boundary. Portal filtering and local signing do
   not establish shared-service security. Keep this integration local.
4. Shared operation still requires a shared session store, distributed rate limits,
   trusted token issuance/revocation, TLS/proxy configuration and live acceptance.
5. This was a targeted source review, not an exhaustive penetration test or a live
   cloud-permissions audit. Full browser/source acceptance remains separate.

## Local restart and login

The MCP build was regenerated. From cnp-portal, restart with npm run dev:integration.
If the admin account still used admin/admin, its password will be replaced at next
startup with ADMIN_INITIAL_PASSWORD in the private cnp-portal/.env. Read it in your
editor; do not paste it into chat or commit it. Existing custom passwords are retained.
