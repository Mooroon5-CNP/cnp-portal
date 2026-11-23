// REAL end-to-end check: portal chat service -> user scope -> HttpMcpClient (signed per-call JWT)
// -> MCP-CNP HTTP server -> REAL Gemini Cloud Assist (local ADC). CNP sources use MCP mock adapters (MOCK_DATA).
// Usage: (cd ../MCP-CNP && npm run build) && GCA_PROJECT_ID=<project> node scripts/test-gca-integration.mjs
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const portalRoot = fileURLToPath(new URL('../', import.meta.url));
const mcpRoot = resolve(process.env.MCP_PROJECT_DIR || resolve(portalRoot, '../MCP-CNP'));
const require = createRequire(import.meta.url);
const load = (path) => import(pathToFileURL(resolve(mcpRoot, 'dist', path)).href);
const { createHttpServer } = await load('apps/mcp-server/src/http.js');
const { createMockAdapters } = await load('apps/mcp-server/src/adapters.js');
const { createGcaClient, createGcaService, gcaConfigFromEnv } = await load('apps/mcp-server/src/gca.js');
const { HttpMcpClient } = require('../apps/orchestrator/src/mcp-client/http-client');
const { createLocalToken } = require('../apps/orchestrator/src/mcp-client/local-token');
const { McpCatalog } = require('../apps/orchestrator/src/catalog/mcp-catalog');
const { createUserScope } = require('../apps/orchestrator/src/sources/user-scope');
const { createChatService } = require('../apps/orchestrator/src/chat/service');
const { chatEventSchema } = require('../packages/contracts/src');

const secret = randomBytes(32).toString('hex');
const port = Number(process.env.GCA_TEST_PORT || 13000);
const config = gcaConfigFromEnv(process.env);
const audit = [];
const server = createHttpServer({
  auth: { secret: new TextEncoder().encode(secret) }, adapters: createMockAdapters(), audit: (record) => audit.push(record),
  gca: createGcaService({ ...config, call: createGcaClient(config) }), requestTimeoutMs: config.timeoutMs + 10_000,
  allowedHosts: ['127.0.0.1'], origins: ['http://localhost:3001'],
});
await server.listen({ host: '127.0.0.1', port });
const client = new HttpMcpClient({ url: `http://127.0.0.1:${port}/mcp`, tokenProvider: (claims) => createLocalToken(secret, claims),
  origin: 'http://localhost:3001', local: true, timeoutMs: 10_000, gcaTimeoutMs: config.timeoutMs + 5_000 });
const catalog = new McpCatalog(client);
const deployments = { listForUser: (user) => (user.role === 'dev' ? [{ app_name: 'sample-api', deployment_environment: 'dev' }] : []) };
const scope = createUserScope(client, catalog, deployments);
const service = createChatService(client, undefined, { classify: async () => ({ kind: 'clarification' }), generateAnswer: undefined });

async function turn(message, role, context) {
  const user = { id: `e2e-${role}`, role };
  const runtime = scope(user);
  const events = [];
  for await (const item of service.run({ message, ...(context ? { context } : {}) }, { ...runtime, actor: { userId: user.id, roles: [role], authenticated: true } })) {
    events.push(chatEventSchema.parse(item));
  }
  return events;
}
const summary = (events) => {
  const last = events.at(-1), answer = events.find((item) => item.type === 'diagnostic_answer');
  return { final: last.type, code: last.code, tools: events.filter((e) => e.type === 'tool_completed').map((e) => `${e.tool}:${e.status}`),
    confidence: answer && answer.answer.confidence.level, cited: answer ? [...new Set([...answer.answer.observations, ...answer.answer.evidence].map((i) => i.source))] : undefined,
    limitations: answer && answer.answer.limitations.filter((l) => /indisponible|synthétiques|divergentes/.test(l)) };
};
try {
  const scenarios = [
    ['1 question GCP', '/gcp Quels services Cloud Run tournent dans ce projet ?', 'manager'],
    ['2 investigation GCP', 'Pourquoi mon service GCP renvoie des erreurs 503 ?', 'devops'],
    ['3 diagnostic transverse', '/diagnostic latence élevée', 'manager', { applicationId: 'sample-api', environment: 'dev' }],
    ['5 utilisateur non autorisé', '/gcp liste les VM', 'dev'],
    ['7 lecture seule', 'Redémarre la VM GCP de production', 'manager'],
    ['6 non-régression CNP', '/deploiement', 'manager', { applicationId: 'sample-api', environment: 'dev' }],
  ];
  for (const [name, message, role, context] of scenarios) {
    const started = Date.now();
    const events = await turn(message, role, context);
    console.log(JSON.stringify({ scenario: name, role, durationMs: Date.now() - started, ...summary(events) }));
  }
  console.log(JSON.stringify({ auditRecords: audit.length, auditLeaksQuestion: JSON.stringify(audit).includes('Cloud Run tournent') }));
} finally { await server.close(); }
