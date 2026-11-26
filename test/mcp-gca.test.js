'use strict';

// MOCKED: the MCP server and Gemini Cloud Assist are simulated; no network call reaches Google Cloud.
const { runChatTurn } = require('../apps/orchestrator/src/chat/service');
const { classifyWithFallback } = require('../apps/orchestrator/src/typesafe/fallback-classifier');
const { FixtureCatalog } = require('../apps/orchestrator/src/catalog/fixture-catalog');
const { createKnownContextBuilder } = require('../apps/orchestrator/src/context/known-context-builder');
const { createUserScope } = require('../apps/orchestrator/src/sources/user-scope');
const { HttpMcpClient } = require('../apps/orchestrator/src/mcp-client/http-client');
const { createMcpClient } = require('../apps/orchestrator/src/mcp-client');
const { createLocalToken } = require('../apps/orchestrator/src/mcp-client/local-token');
const { buildTransverseAnswer } = require('../apps/orchestrator/src/generation/diagnostic');
const { describeDiagnostic } = require('../public/js/mcp-results');
const { chatEventSchema, gcpCloudAssistResponseSchema, responseSchemas } = require('../packages/contracts/src');

const NOW = '2026-11-19T10:00:00.000Z';
const meta = (tool, correlationId, sources) => ({ tool, schemaVersion: '1.0', correlationId, generatedAt: NOW, sources });
const gcaAnswer = {
  summary: 'Le service Cloud Run répond avec une latence élevée.',
  observations: [{ source: 'gemini_cloud_assist', fact: 'p95 de 2,1 s sur la révision 00042.', resource: 'run/majoutes-api', observedAt: NOW }],
  diagnosis: [{ kind: 'hypothesis', statement: 'Démarrages à froid.' }],
  evidence: [{ source: 'gemini_cloud_assist', resource: 'run/majoutes-api', period: { from: '2026-11-19T09:00:00.000Z', to: NOW }, observedAt: null, values: 'p95=2.1s' }],
  recommendations: [{ priority: 1, action: 'Évaluer min-instances=1.', executed: false }],
  confidence: { level: 'medium', justification: 'Une heure de métriques.' },
  limitations: ['Identité de service partagée.'],
};
const gcaResponse = (args, correlationId) => gcpCloudAssistResponseSchema.parse({
  status: 'success', warnings: [], errors: [], meta: meta('gcp_cloud_assist', correlationId, [{ source: 'gemini_cloud_assist', status: 'available', retrievedAt: NOW }]),
  data: { capability: args.capability, conversationId: args.conversationId, sessionContinued: false, structured: true, actionProposed: false, answer: gcaAnswer },
});
const deploymentResponse = (args, correlationId) => responseSchemas.get_deployment_status.parse({
  status: 'success', warnings: [], errors: [],
  meta: meta('get_deployment_status', correlationId, ['platform', 'git', 'argo'].map((source) => ({ source, status: 'available', retrievedAt: NOW }))),
  data: { ...args, desiredState: { version: '1.4.0', imageDigest: null, sourceRevision: 'abc' }, observedState: { version: '1.4.0', imageDigest: null, syncStatus: 'Synced', healthStatus: 'Healthy' }, driftDetected: false, lastDeploymentAt: NOW },
});
const logsResponse = (args, correlationId) => responseSchemas.get_application_logs.parse({
  status: 'success', warnings: [], errors: [],
  meta: meta('get_application_logs', correlationId, [{ source: 'platform', status: 'available', retrievedAt: NOW }, { source: 'datadog', status: 'available', retrievedAt: NOW }]),
  data: { logs: [{ timestamp: NOW, level: 'ERROR', message: 'upstream timeout', service: 'majoutes-api', version: '1.4.0', correlationId: null }], nextCursor: null, truncated: false, redactedFields: 0 },
});
function stubClient(overrides = {}) {
  const handlers = { gcp_cloud_assist: gcaResponse, get_deployment_status: deploymentResponse, get_application_logs: logsResponse, ...overrides };
  return { callTool: jest.fn(async (tool, args, metadata) => {
    const handler = handlers[tool];
    if (!handler) throw Object.assign(new Error('TOOL_UNAVAILABLE'), { code: 'TOOL_UNAVAILABLE' });
    return handler(args, metadata.correlationId);
  }) };
}
async function turn(message, { roles = ['manager'], context, mcpClient = stubClient(), generateAnswer, gcaChatEnabled = true, gcaRoles } = {}) {
  const events = [];
  for await (const item of runChatTurn({ message, ...(context ? { context } : {}) }, {
    mcpClient, classify: classifyWithFallback, buildKnownContext: createKnownContextBuilder(new FixtureCatalog()),
    actor: { userId: 'user-1', roles, authenticated: true }, now: () => new Date(NOW), generateAnswer, gcaChatEnabled,
    ...(gcaRoles ? { gcaRoles } : {}),
  })) events.push(chatEventSchema.parse(item));
  return { events, mcpClient, types: events.map((item) => item.type) };
}
const answerOf = (events) => events.find((item) => item.type === 'diagnostic_answer');

describe('Gemini Cloud Assist in the portal chat (MOCKED)', () => {
  test('scenario 1: a GCP question calls GCA and returns a validated 7-section answer without the generative model', async () => {
    const generateAnswer = jest.fn();
    const { events, mcpClient } = await turn('/gcp quels services Cloud Run sont lents ?', { generateAnswer });
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    const [tool, args, metadata] = mcpClient.callTool.mock.calls[0];
    expect(tool).toBe('gcp_cloud_assist');
    expect(args).toMatchObject({ capability: 'ask_cloud_assist' });
    expect(metadata.actor).toEqual({ userId: 'user-1', roles: ['manager'], authenticated: true });
    expect(answerOf(events).sources).toEqual([{ source: 'gemini_cloud_assist', status: 'available' }]);
    expect(generateAnswer).not.toHaveBeenCalled();
  });
  test('scenario 2: explicit GCP incident vocabulary selects investigate_issue; generic Cloud Run cost wording keeps FinOps routing', async () => {
    const { mcpClient } = await turn('Pourquoi mon service GCP renvoie des erreurs ?');
    expect(mcpClient.callTool.mock.calls[0][1].capability).toBe('investigate_issue');
    expect(classifyWithFallback('quel cout pour cloud run')).toEqual({ kind: 'tool', tool: 'get_finops_recommendation', fallback: true });
  });
  test('explicit slash commands keep their own tool even when the message mentions GCP', async () => {
    for (const [message, tool] of [['/logs mon app gcp', 'get_application_logs'], ['/deploiement google cloud', 'get_deployment_status']]) {
      const { mcpClient } = await turn(message, { roles: ['dev'], context: { applicationId: 'majoutes-api', environment: 'dev' } });
      const tools = mcpClient.callTool.mock.calls.map(([name]) => name);
      expect(tools).not.toContain('gcp_cloud_assist');
      expect(tools).toContain(tool);
    }
  });
  test('scenario 3: /diagnostic combines Argo CD, Git, Datadog and GCA, each cited source having been called', async () => {
    const { events, mcpClient } = await turn('/diagnostic latence élevée', { context: { applicationId: 'majoutes-api', environment: 'dev' } });
    expect(mcpClient.callTool.mock.calls.map(([tool]) => tool).sort()).toEqual(['gcp_cloud_assist', 'get_application_logs', 'get_deployment_status']);
    const { answer, sources } = answerOf(events);
    const cited = new Set([...answer.observations, ...answer.evidence].map((item) => item.source));
    expect([...cited].sort()).toEqual(['argo', 'datadog', 'gemini_cloud_assist', 'git']);
    expect([...cited].every((source) => sources.some((item) => item.source === source && item.status === 'available'))).toBe(true);
    expect(answer.limitations.join(' ')).toMatch(/Sources divergentes/);
    expect(describeDiagnostic(answer).map((section) => section.title)).toEqual([
      '1. Résumé', '2. Observations', '3. Diagnostic / interprétation', '4. Éléments de preuve',
      '5. Recommandations (non exécutées)', '6. Niveau de confiance', '7. Limites / données manquantes']);
  });
  test('scenario 4: without any data the answer says so with low confidence instead of inventing', () => {
    const fail = { errorCode: 'SOURCE_UNAVAILABLE' };
    const answer = buildTransverseAnswer({ target: { applicationId: 'majoutes-api', environment: 'dev' }, logWindow: { from: NOW, to: NOW },
      results: { get_deployment_status: fail, get_application_logs: fail, gcp_cloud_assist: { errorCode: 'GCA_TIMEOUT' } } });
    expect(answer).toMatchObject({ observations: [], evidence: [], recommendations: [], confidence: { level: 'low' } });
    expect(answer.limitations.join(' ')).toMatch(/Aucune donnée fiable/);
  });
  test('scenario 5: a dev role, or an application outside the user scope, never reaches GCA', async () => {
    const dev = await turn('/gcp liste mes VM', { roles: ['dev'] });
    expect(dev.events.at(-1)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(dev.mcpClient.callTool).not.toHaveBeenCalled();
    const client = { callTool: jest.fn() };
    const scoped = createUserScope(client, new FixtureCatalog(), { listForUser: () => [{ app_name: 'majoutes-api', deployment_environment: 'dev' }] })({ id: 'u', role: 'devops' });
    await expect(scoped.mcpClient.callTool('gcp_cloud_assist', { capability: 'ask_cloud_assist', question: 'q', conversationId: 'c', applicationId: 'other-app', environment: 'dev' }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(scoped.mcpClient.callTool('gcp_cloud_assist', { capability: 'ask_cloud_assist', question: 'q', conversationId: 'c', applicationId: 'majoutes-api', environment: 'prod' }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(client.callTool).not.toHaveBeenCalled();
    client.callTool.mockResolvedValue({ status: 'success' });
    await scoped.mcpClient.callTool('gcp_cloud_assist', { capability: 'ask_cloud_assist', question: 'q', conversationId: 'c', applicationId: 'majoutes-api', environment: 'dev' }, { correlationId: 'x' });
    expect(client.callTool.mock.calls[0][2]).toEqual({ correlationId: 'x', authorizedTarget: { applicationId: 'majoutes-api', environment: 'dev' } });
  });
  test('scenario 6: GCA unavailable is reported cleanly; the diagnosis still uses the other sources; CNP tools keep working', async () => {
    const denied = (args, correlationId) => gcpCloudAssistResponseSchema.parse({ status: 'error', data: null, warnings: [], meta: meta('gcp_cloud_assist', correlationId, [{ source: 'gemini_cloud_assist', status: 'unavailable' }]),
      errors: [{ code: 'GCA_PERMISSION_DENIED', message: 'denied', source: 'gemini_cloud_assist', retryable: false }] });
    const single = await turn('/gcp état de mes buckets', { mcpClient: stubClient({ gcp_cloud_assist: denied }) });
    expect(single.events.at(-1)).toMatchObject({ type: 'error', code: 'GCA_PERMISSION_DENIED', retryable: false });
    const down = async () => { throw Object.assign(new Error('MCP_TIMEOUT'), { code: 'MCP_TIMEOUT' }); };
    const cross = await turn('/diagnostic', { context: { applicationId: 'majoutes-api', environment: 'dev' }, mcpClient: stubClient({ gcp_cloud_assist: down }) });
    const { answer } = answerOf(cross.events);
    expect(answer.limitations.join(' ')).toMatch(/Gemini Cloud Assist indisponible \(MCP_TIMEOUT\)/);
    expect(answer.observations.some((item) => item.source === 'gemini_cloud_assist')).toBe(false);
    expect(answer.confidence.level).toBe('low');
    const cnp = await turn('/deploiement', { context: { applicationId: 'majoutes-api', environment: 'dev' } });
    expect(cnp.types).toContain('tool_result');
  });
  test('scenario 7: a mutation request mentioning GCP is refused before any call; recommendations are never executed', async () => {
    const { events, mcpClient } = await turn('Redémarre la VM GCP de production');
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'FORBIDDEN' });
    expect(mcpClient.callTool).not.toHaveBeenCalled();
    const executed = { ...gcaAnswer, recommendations: [{ priority: 1, action: 'restart', executed: true }] };
    expect(() => gcpCloudAssistResponseSchema.parse({ status: 'success', warnings: [], errors: [], meta: meta('gcp_cloud_assist', 'c', [{ source: 'gemini_cloud_assist', status: 'available' }]),
      data: { capability: 'ask_cloud_assist', conversationId: 'c', sessionContinued: false, structured: true, actionProposed: false, answer: executed } })).toThrow();
  });
  test('GCA is reserved to managers: dev and devops get an unavailable message and never reach the MCP', async () => {
    for (const role of ['dev', 'devops']) {
      const result = await turn('/gcp quels services Cloud Run sont en erreur ?', { roles: [role] });
      expect(result.events.at(-1)).toMatchObject({ type: 'error', code: 'FORBIDDEN', retryable: false });
      expect(result.events.at(-1).message).toMatch(/indisponible pour votre rôle/);
      expect(result.events.at(-1).link).toBeUndefined();
      expect(result.mcpClient.callTool).not.toHaveBeenCalled();
    }
  });
  test('while the Google preview is closed, managers get a console link instead of a failing call', async () => {
    for (const message of ['/gcp quels services Cloud Run sont en erreur ?', '/diagnostic']) {
      const result = await turn(message, { gcaChatEnabled: false, context: { applicationId: 'majoutes-api', environment: 'dev' } });
      expect(result.events.at(-1)).toMatchObject({ type: 'error', code: 'GCA_NOT_ENABLED', retryable: false,
        link: { href: 'https://console.cloud.google.com/home/dashboard?project=cnp-terraform-515922' } });
      expect(result.mcpClient.callTool).not.toHaveBeenCalled();
    }
  });
  test('an error link outside the Google Cloud console is rejected by the event contract', () => {
    const base = { type: 'error', correlationId: '00000000-0000-4000-8000-000000000000', code: 'X', message: 'm', retryable: false };
    expect(() => chatEventSchema.parse({ ...base, link: { href: 'https://evil.example/', label: 'x' } })).toThrow();
    expect(chatEventSchema.parse({ ...base, link: { href: 'https://console.cloud.google.com/home', label: 'x' } }).link.href).toMatch(/^https:/);
  });
  test('a bare /gcp asks for the question instead of calling GCA', async () => {
    const { events, mcpClient } = await turn('/gcp');
    expect(events.at(-1).type).toBe('clarification_required');
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });
});

describe('Portal → MCP connection for a shared deployment (MOCKED)', () => {
  const secret = 'test-only-secret-with-more-than-32-bytes!';
  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  test('signs per-call claims: user and role always, application and environment only once authorized', () => {
    const claims = decode(createLocalToken(secret, { sub: 'user-1', role: 'manager', app: 'majoutes-api', env: 'dev' }));
    expect(claims).toMatchObject({ iss: 'cnp-portal', aud: 'cnp-mcp', sub: 'user-1', role: 'manager', app: 'majoutes-api', env: 'dev', scopes: ['cnp:read'] });
    expect(claims.exp - claims.iat).toBe(300);
    expect(decode(createLocalToken(secret))).not.toHaveProperty('app');
  });
  test('passes the authorized target to the token provider and never to an unauthorized call', async () => {
    const tokenProvider = jest.fn(() => 'token');
    const client = new HttpMcpClient({ url: 'http://127.0.0.1:9/mcp', tokenProvider, origin: 'http://localhost:3001', local: true, timeoutMs: 500 });
    const args = { capability: 'ask_cloud_assist', question: 'q', conversationId: 'c', applicationId: 'majoutes-api', environment: 'dev' };
    await expect(client.callTool('gcp_cloud_assist', args, { correlationId: 'x', actor: { userId: 'user-1', roles: ['devops'] }, authorizedTarget: { applicationId: 'majoutes-api', environment: 'dev' } })).rejects.toBeTruthy();
    await expect(client.callTool('gcp_cloud_assist', args, { correlationId: 'x', actor: { userId: 'user-1', roles: ['devops'] } })).rejects.toBeTruthy();
    expect(tokenProvider.mock.calls).toEqual([[{ sub: 'user-1', role: 'devops', app: 'majoutes-api', env: 'dev' }], [{ sub: 'user-1', role: 'devops' }]]);
  });
  test('fetches and caches the Cloud Run identity token from the metadata server', async () => {
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const fetch = jest.fn(async () => ({ ok: true, text: async () => `h.${payload}.s` }));
    const client = new HttpMcpClient({ url: 'https://cnp-mcp-1.europe-west9.run.app/mcp', token: 't', origin: 'https://portal.example.invalid', iamAudience: 'https://cnp-mcp-1.europe-west9.run.app', fetch });
    expect(await client.identityToken()).toBe(`h.${payload}.s`);
    await client.identityToken();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('audience=https%3A%2F%2Fcnp-mcp-1.europe-west9.run.app');
    expect(fetch.mock.calls[0][1].headers).toEqual({ 'Metadata-Flavor': 'Google' });
  });
  test('shared-environment signing requires HTTPS', () => {
    expect(() => createMcpClient({ MCP_CLIENT_MODE: 'http', MCP_URL: 'http://cnp-mcp.example.invalid/mcp', MCP_ORIGIN: 'https://portal.example.invalid', MCP_JWT_SECRET: secret })).toThrow(/HTTPS/);
    expect(createMcpClient({ MCP_CLIENT_MODE: 'http', MCP_URL: 'https://cnp-mcp.example.invalid/mcp', MCP_ORIGIN: 'https://portal.example.invalid', MCP_JWT_SECRET: secret })).toBeInstanceOf(HttpMcpClient);
  });
});
