# MCP integration and proxy-addr CI fix — 2026-11-03

The reported Trivy failure identifies CVE-2026-90711 in proxy-addr 2.0.7.
The portal now pins proxy-addr 2.0.8 through an npm override and locks its published
npm URL/integrity. This covers both Express 4 and the MCP SDK's Express 5 dependency.
No scanner settings, vulnerability severities or ignore rules were relaxed.

Primary release: https://github.com/jshttp/proxy-addr/releases/tag/v2.0.8
The lock metadata was cross-checked against Microsoft's playwright-mcp lockfile
because this terminal cannot resolve registry.npmjs.org. Installed test code was
read from the official jshttp/proxy-addr v2.0.8 release; npm ci against the npm
artifact and Trivy must be verified by GitHub Actions. npm ls resolves both
Express consumers to 2.0.8 locally.

Regression tests prove that short IPv4-mapped IPv6 subnets and ::/1 cannot trust
arbitrary IPv4 clients, while correctly configured private proxy subnets retain
forwarded-address behavior.

The integration includes remote main 25e9159, preserving reserved Argo account
checks, bounded Cloud Run AppProject selection, updated portal RBAC and the
existing application CI workflow. The Docker stages use Node 24, matching portal
validation and supporting the MCP/AI dependencies. No private .env or credentials
are committed. Production still requires a strong SESSION_SECRET and, for a fresh
or default-admin database, ADMIN_INITIAL_PASSWORD; merging code does not provision
those runtime secrets.

Validation: portal lint passed; 239 tests passed across 35 suites on Node 26.13.0.
Five listener-dependent suites were excluded because the sandbox rejects sockets:
deployment-environment-routes, azure-route, index.test, mcp-user-access and
argocd-sync-route. GitHub Actions must run the complete suite and dependency/image
scans. Local Docker verification was blocked by daemon socket permissions.
Generation/context harnesses use simulated AI responses; no live AI/cloud call
was used for the security regression tests.

The original working branch was local only. Publication consolidates its tested
contents with remote main and the published feat/MCPapi history; local-only fixes
are grouped in that integration commit. Delete the local continuation branch only
after the published tree matches the tested tree. Other feature branches remain
outside this cleanup.
