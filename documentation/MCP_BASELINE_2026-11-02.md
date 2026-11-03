> Later same-day update: Argo hardening is now integrated; dependencies became
> available and targeted validation passed. See [the security review](SECURITY_REVIEW_2026-11-02.md)
> for current fixes, results and remaining blockers. The baseline below is historical.

# MCP integration baseline — 2026-11-02

## Revisions and branches

GitHub connector comparisons confirmed these refs identical to the local snapshot on
2026-11-02: portal main `f1c78d1`, portal feat/MCPapi `6249299`, MCP main
`8ab5453`, MCP docs/mcp-integration-specs `c8771e9`.

- Portal continuation: `integrate/mcp-main-20261102`; merge commit `8b14867`
  has parents main `f1c78d1` and MCP `6249299`. No textual conflicts.
- MCP continuation: `integrate/mcp-specs-20261102`, based on `c8771e9`;
  contains MCP main and all six existing specs.
- Existing branches and main remain unchanged. No push, PR merge or deployment.
- The native launcher is reused; no additional facade or replacement chat was built.

## Validation evidence

| Check | Result |
| --- | --- |
| Portal merge | Successful; both branch histories preserved |
| Azure environment service and Azure deployment/environment tests against main | No diff |
| Portal JavaScript syntax | 98 files checked with node --check; all passed |
| Whitespace | git diff --check passed |
| MCP typecheck/lint/tests/schemas/build | Blocked: tsc/eslint/vitest/tsx missing |
| Portal lint/Jest/generation/context/integration | Blocked: dependencies and MCP build missing |
| npm ci in both repos | Failed: EAI_AGAIN resolving registry.npmjs.org |
| Offline install | Failed: incomplete npm cache (including zod-to-json-schema) |
| Live sources and browser demo | Not run; no current functional claim |

Runtime available here: Node 26.13.0. Existing documented/tested baseline is Node 24;
use Node 24 for the full rerun. Syntax checks do not prove runtime behavior.
The original portal merge already removes 3,146 tracked virtualenv files; do not
restore them. The Python source and requirements remain for the synthetic harness.

## Remaining branches

Counts are local remote-tracking refs against origin/main (main-only / branch-only).

| Portal branch | Counts | Disposition |
| --- | --- | --- |
| feat/MCPapi | 10 / 9 | Integrated into continuation branch; preserve until reviewed |
| feat/deployment-environment-selection | 11 / 0 | Already contained in main; no further merge |
| feat/azure-deployment | 1 / 0 | Already contained in main |
| dev | 39 / 0 | Historical commits contained in main |
| fix/remove-npm-from-final-image | 23 / 0 | Already contained in main |
| fix/argocd-portal-least-privilege | 10 / 1 | Separate security change; NOT contained in MCP branch |
| feat/cnp-046-portal-chat | 22 / 1 | Older alternative; reuse existing MCP integration instead |
| feat/cnp-037-observability-defaults | 22 / 1 | Separate observability review |
| feature/observability-per-app | 31 / 5 | Separate observability review; reconcile overlap later |
| chore/update-gcp-project-values | 31 / 1 | Separate project migration review |
| feat/config-repo-writes-via-github-app | 31 / 1 | Inspect overlap with existing publication path later |
| feat/failover-phase1-pixelcalm | 0 / 1 | Separate failover scope |
| prod | 94 / 1 | Preserve release branch; no cleanup implied |

MCP docs branch is 0 / 2 versus main and is included in the continuation branch.
No branches were deleted. Config-repo was not modified; its failover/release work
remains separate. Containment alone is not approval to delete a release branch.

Correction to earlier notes: git merge-base --is-ancestor a1c26bb 6249299 returns 1,
and git cherry HEAD origin/fix/argocd-portal-least-privilege marks the hardening
patch as absent. Review PR #11 separately; recheck Azure mocks if integrating it.

## Resume toward the first visible result

1. Restore npm registry access and use Node 24; npm ci in both repositories.
2. MCP: typecheck, lint, test, schemas, build. Portal: lint, Jest --runInBand,
   test:generation, test:context, test:integration. The last harness requires a
   Python environment installed from services/platform-api/requirements.txt;
   point PLATFORM_PYTHON at it. This is synthetic acceptance, not live evidence.
3. Launch npm run dev:integration:mock from portal for a labelled synthetic chat
   at http://localhost:3001/mcp-chat. Authenticate and exercise /applications,
   then explicit application/environment commands. Keep this local.
4. Run the existing isolated test:live-environments harness with configured native
   sources. Do not run the full portal against a production database just to test
   read-only chat: its deployment reconciler retains write responsibilities.
5. Close SPEC-02 before any shared hosting. Continue using the implementation
   checklist in MCP specs/INTEGRATION-2026-11-02.md. No billing/RAG expansion yet.
