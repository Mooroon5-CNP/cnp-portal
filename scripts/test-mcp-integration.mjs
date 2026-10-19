// Real portal client -> MCP HTTP server -> HTTPS Platform API, with synthetic other sources.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

const portalRoot = fileURLToPath(new URL('../', import.meta.url));
const mcpRoot = resolve(process.env.MCP_PROJECT_DIR || resolve(portalRoot, '../MCP-CNP'));
const require = createRequire(import.meta.url);
const mcpRequire = createRequire(resolve(mcpRoot, 'package.json'));
const load = (path) => import(pathToFileURL(resolve(mcpRoot, path)).href);
const { createHttpServer } = await load('dist/apps/mcp-server/src/http.js');
const { createMockAdapters } = await load('dist/apps/mcp-server/src/adapters.js');
const { createHttpAdapters } = await load('dist/apps/mcp-server/src/http-adapters.js');
const { SignJWT } = await import(pathToFileURL(mcpRequire.resolve('jose')).href);
const { HttpMcpClient } = require('../apps/orchestrator/src/mcp-client/http-client');
const { McpCatalog } = require('../apps/orchestrator/src/catalog/mcp-catalog');
const { createKnownContextBuilder } = require('../apps/orchestrator/src/context/known-context-builder');
const { createChatService } = require('../apps/orchestrator/src/chat/service');
const { buildToolArguments } = require('../apps/orchestrator/src/orchestration/arguments');
const { inputSchemas, responseSchemas, toolNames } = require('../packages/contracts/src');
const mcpContracts = await load('dist/packages/contracts/src/index.js');

const temporary = await mkdtemp(resolve(tmpdir(), 'cnp-integration-'));
let api, server;
let apiOutput = '';
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', resolve(temporary, 'key.pem'), '-out', resolve(temporary, 'cert.pem'),
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  const ca = await readFile(resolve(temporary, 'cert.pem'));
  const platformPort = process.env.PLATFORM_TEST_PORT || '18443';
  const baseUrl = `https://127.0.0.1:${platformPort}`;
  const serviceToken = randomUUID();
  const apiDir = resolve(portalRoot, 'services/platform-api');
  const python = process.env.PLATFORM_PYTHON || resolve(apiDir, '.venv/bin/python');
  api = spawn(python, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', platformPort,
    '--ssl-keyfile', resolve(temporary, 'key.pem'), '--ssl-certfile', resolve(temporary, 'cert.pem')],
  { cwd: apiDir, env: { ...process.env, PLATFORM_API_SERVICE_TOKEN: serviceToken }, stdio: ['ignore', 'pipe', 'pipe'] });
  api.stdout.on('data', (chunk) => { apiOutput += chunk; });
  api.stderr.on('data', (chunk) => { apiOutput += chunk; });
  let spawnError;
  api.on('error', (error) => { spawnError = error; });
  // Trust only the temporary test CA; certificate verification remains enabled.
  const trustedFetch = (url, options = {}) => new Promise((accept, reject) => {
    const request = https.request(url, { ca, method: options.method || 'GET', headers: options.headers, signal: options.signal }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => accept(new Response(Buffer.concat(chunks), { status: response.statusCode })));
    });
    request.on('error', reject);
    request.end();
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnError) throw spawnError;
    if (api.exitCode !== null) throw new Error(`Platform API exited: ${apiOutput}`);
    try { ready = (await trustedFetch(`${baseUrl}/healthz`)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  assert.ok(ready, `Platform API startup timed out: ${apiOutput}`);
  const source = { baseUrl, token: serviceToken };
  const real = createHttpAdapters({ platform: source, git: source, argo: source, kubernetes: source, datadog: source, fetch: trustedFetch });
  assert.equal((await real.platform.get('majoutes-api')).applicationId, 'majoutes-api');
  assert.deepEqual(await real.platform.workload('majoutes-api', 'dev'), {
    platform: 'cloud_run', stateless: true, http: true, requiresKubernetes: false,
  });
  const unauthorized = createHttpAdapters({ platform: { ...source, token: 'wrong' }, git: source, argo: source, kubernetes: source, datadog: source, fetch: trustedFetch });
  await assert.rejects(() => unauthorized.platform.list({ limit: 20 }));
  const secret = new TextEncoder().encode(randomUUID() + randomUUID());
  const token = await new SignJWT({ login: 'integration', scopes: ['cnp:read'] })
    .setProtectedHeader({ alg: 'HS256' }).setIssuer('cnp-portal').setAudience('cnp-mcp')
    .setSubject('integration').setJti(randomUUID()).setIssuedAt().setExpirationTime('5m').sign(secret);
  const audits = [];
  server = createHttpServer({ auth: { secret }, adapters: { ...createMockAdapters(), platform: real.platform },
    origins: ['http://localhost:3000'], audit: (value) => audits.push(value) });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const client = new HttpMcpClient({ url: `${address}/mcp`, token, origin: 'http://localhost:3000', local: true });
  const { createMcpClient } = require('../apps/orchestrator/src/mcp-client');
  const renewable = createMcpClient({ NODE_ENV: 'development', MCP_CLIENT_MODE: 'http',
    MCP_URL: `${address}/mcp`, MCP_ORIGIN: 'http://localhost:3000', MCP_LOCAL_HTTP: 'true',
    MCP_LOCAL_JWT_SECRET: new TextDecoder().decode(secret) });
  assert.equal((await renewable.callTool('list_applications', { limit: 20 }, { correlationId: randomUUID() })).status, 'success');
  assert.throws(() => createMcpClient({ NODE_ENV: 'production', MCP_CLIENT_MODE: 'http',
    MCP_URL: `${address}/mcp`, MCP_ORIGIN: 'http://localhost:3000', MCP_LOCAL_HTTP: 'true',
    MCP_LOCAL_JWT_SECRET: new TextDecoder().decode(secret) }), /Local JWT signing/);
  const catalog = new McpCatalog(client);
  assert.equal((await catalog.listApplications())[0].applicationId, 'majoutes-api');
  const context = await createKnownContextBuilder(catalog)({
    actor: { userId: "1", roles: ['manager'], authenticated: true },
    portalContext: { applicationId: 'majoutes-api', environment: 'dev' },
  });
  for (const tool of toolNames) {
    const args = buildToolArguments(tool, context);
    assert.ok(mcpContracts.inputSchemas[tool].safeParse(inputSchemas[tool].parse(args)).success, `${tool}: input mismatch`);
    const correlationId = randomUUID();
    const result = await client.callTool(tool, args, { correlationId });
    assert.notEqual(result.status, 'error', `${tool}: ${JSON.stringify(result.errors)}`);
    assert.ok(responseSchemas[tool].safeParse(result).success, `${tool}: portal response mismatch`);
    assert.ok(mcpContracts.responseSchemas[tool].safeParse(result).success, `${tool}: MCP response mismatch`);
    assert.equal(result.meta.correlationId, correlationId);
    if (tool === 'get_application_logs') assert.ok(Object.hasOwn(result.data, 'nextCursor'));
  }
  const chat = createChatService(client, createKnownContextBuilder(catalog));
  const events = [];
  for await (const event of chat.run({ message: 'Liste les applications' }, {
    actor: { userId: "1", roles: ['manager'], authenticated: true },
  })) events.push(event);
  assert.equal(events.at(-1).type, 'turn_completed');
  assert.match(events.find((event) => event.type === 'answer_delta').text, /Majoutes API/);
  // Exercise the actual authenticated portal SSE route with a numeric SQLite user ID.
  const express = require('express');
  const request = require('supertest');
  const { createRouter } = require('../apps/orchestrator/src/http/router');
  const web = express();
  const session = {};
  web.use(express.json());
  web.use((req, res, next) => {
    req.session = session;
    req.user = { id: 1, role: 'manager' };
    res.render = (_view, values) => res.json({ csrfToken: values.csrfToken });
    next();
  });
  web.use(createRouter({ requireAuth: (_req, _res, next) => next(), chatService: chat, catalog }));
  const page = await request(web).get('/mcp-chat').expect(200);
  await request(web).post('/api/v1/mcp/chat/turn').send({ message: 'Liste les applications' }).expect(403);
  const streamed = await request(web).post('/api/v1/mcp/chat/turn')
    .set('x-cnp-csrf', page.body.csrfToken).send({ message: 'Liste les applications' }).expect(200);
  assert.match(streamed.headers['content-type'], /text\/event-stream/);
  assert.match(streamed.text, /event: turn_completed/);
  assert.match(streamed.text, /Majoutes API/);
  const count = audits.length;
  for await (const event of chat.run({ message: 'supprimer majoutes-api' }, {
    actor: { userId: "1", roles: ['manager'], authenticated: true },
  })) assert.notEqual(event.type, 'tool_started');
  assert.equal(audits.slice(count).filter((value) => value.tool !== 'list_applications').length, 0);
  const badClient = new HttpMcpClient({ url: `${address}/mcp`, token: 'wrong', origin: 'http://localhost:3000', local: true });
  await assert.rejects(() => badClient.callTool('list_applications', { limit: 20 }, { correlationId: randomUUID() }), { code: 'MCP_UNAUTHENTICATED' });
  const forbidden = new HttpMcpClient({ url: `${address}/mcp`, token, origin: 'http://localhost:9999', local: true });
  await assert.rejects(() => forbidden.callTool('list_applications', { limit: 20 }, { correlationId: randomUUID() }), { code: 'MCP_FORBIDDEN' });
  console.log('PASS: portal chat/client, four MCP tools, matching contracts, authenticated HTTPS Platform API, workload, correlation, and denied credentials.');
  console.log('Synthetic data: Platform API fixture; mock Git/Argo/Kubernetes/Datadog. TypeSafe is not exercised here.');
} finally {
  if (server) await server.close();
  if (api && api.exitCode === null && api.pid) {
    const stopped = new Promise((accept) => api.once('exit', accept));
    api.kill('SIGTERM');
    await stopped;
  }
  await rm(temporary, { recursive: true, force: true });
}
