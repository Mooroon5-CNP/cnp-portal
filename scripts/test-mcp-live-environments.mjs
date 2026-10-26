// Read-only cloud recipe using real login, portal SSE, MCP HTTP and native adapters.
// Uses an isolated temporary database. Never starts the deployment reconciler.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const mcpRoot = resolve(process.env.MCP_PROJECT_DIR || '../MCP-CNP');
const temporary = await mkdtemp(resolve(tmpdir(), 'cnp-live-mcp-'));
const applicationId = process.argv[2] || 'app4-pixelcam';
let server, database;
try {
  require('dotenv').config({ path: process.env.MCP_PORTAL_ENV_FILE || resolve(root, '.env'), quiet: true });
  Object.assign(process.env, { DB_PATH: resolve(temporary, 'recipe.sqlite'), NODE_ENV: 'development',
    MCP_CLIENT_MODE: 'http', MCP_DATA_MODE: 'real', MCP_ROUTING_MODE: 'local',
    GENAI_ENABLED: 'false', TYPESAFE_ENABLED: 'false', MCP_LOCAL_HTTP: 'true',
    MCP_ORIGIN: 'http://localhost:3001', MCP_LOCAL_JWT_SECRET: randomBytes(32).toString('hex') });
  const load = file => import(pathToFileURL(resolve(mcpRoot, 'dist/apps/mcp-server/src', file)).href);
  const { createHttpServer } = await load('http.js');
  const { SourceError } = await load('adapters.js');
  const { createNativeAdapters } = require('../apps/orchestrator/src/sources/native-adapters.cjs');
  const adapters = createNativeAdapters({ SourceError });
  const audits = [];
  server = createHttpServer({ auth: { secret: new TextEncoder().encode(process.env.MCP_LOCAL_JWT_SECRET) },
    adapters, allowedHosts: ['127.0.0.1', 'localhost'], origins: [process.env.MCP_ORIGIN],
    audit: value => audits.push(value) });
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  process.env.MCP_URL = `${address}/mcp`;
  const app = require('../src/index');
  database = require('../src/models/db');
  const request = require('supertest');
  await request(app).get('/api/v1/mcp/catalog').expect(302);
  const agent = request.agent(app);
  await agent.post('/auth/login').type('form').send({ username: 'admin', password: 'admin' }).expect(302);
  const page = await agent.get('/mcp-chat').expect(200);
  const csrf = page.text.match(/data-csrf-token="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf, 'Real authenticated page must expose a CSRF token');
  const catalog = await agent.get('/api/v1/mcp/catalog').expect(200);
  const application = catalog.body.applications.find(item => item.applicationId === applicationId);
  assert.ok(application, 'Live application must be registered');
  for (const environment of ['dev', 'prod']) {
    assert.ok(application.environments.some(item => item.name === environment && item.enabled));
    const response = await agent.post('/api/v1/mcp/chat/turn').set('x-cnp-csrf', csrf)
      .send({ message: `/deploiement ${applicationId} en ${environment}` }).expect(200);
    const events = response.text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    const result = events.find(item => item.type === 'tool_result');
    assert.ok(result, `Expected structured result for ${environment}: ${events.map(item => item.type + ':' + (item.code || '')).join(',')}`);
    const data = result.result?.data || result.data;
    assert.ok(data, 'Structured event must include data');
    assert.equal(data.applicationId, applicationId);
    assert.equal(data.environment, environment);
    assert.match(data.desiredState.version, /^[a-f0-9]{40}$/);
    assert.equal(data.observedState.version, data.desiredState.version, 'Actual serving revision must match desired image');
    const runtime = await require('../src/clients/kubernetes').getV2ServiceStatus(`${applicationId}-${environment}`);
    assert.equal(runtime.ready, true, 'Cloud Run must actually be ready');
    assert.ok(events.some(item => item.type === 'turn_completed'));
    const raw = JSON.stringify(events);
    assert.ok(!raw.includes('MOCK_DATA'));
    assert.ok(!raw.includes(process.env.MCP_LOCAL_JWT_SECRET));
    console.log(JSON.stringify({ environment, applicationId, desired: data.desiredState.version,
      observed: data.observedState.version, argoSync: data.observedState.syncStatus,
      health: data.observedState.healthStatus, result: result.result?.status || result.status || 'structured' }));
  }
  assert.ok(audits.filter(item => item.tool === 'get_deployment_status').length >= 2);
  // Real portal authorization with an isolated local dev-only account; cloud remains read-only.
  const bcrypt = require('bcryptjs');
  const { randomUUID } = require('node:crypto');
  const userId = randomUUID(), now = new Date().toISOString();
  database.prepare('INSERT INTO users (id,username,password_hash,role,active,approved,created_at,updated_at) VALUES (?,?,?,?,1,1,?,?)')
    .run(userId, 'recipe-dev', bcrypt.hashSync('recipe-local-only', 4), 'dev', now, now);
  require('../src/models/deployment').create({ appName: applicationId, githubRepoUrl: application.repositoryUrl,
    appPort: 8080, ownerUserId: userId, environment: 'dev' });
  const restricted = request.agent(app);
  await restricted.post('/auth/login').type('form').send({ username: 'recipe-dev', password: 'recipe-local-only' }).expect(302);
  const scoped = await restricted.get('/api/v1/mcp/catalog').expect(200);
  assert.deepEqual(scoped.body.applications.map(item => [item.applicationId, item.environments.map(env => env.name)]),
    [[applicationId, ['dev']]]);
  const restrictedPage = await restricted.get('/mcp-chat').expect(200);
  const restrictedCsrf = restrictedPage.text.match(/data-csrf-token="([a-f0-9]+)"/)?.[1];
  const before = audits.filter(item => item.tool === 'get_deployment_status').length;
  const denied = await restricted.post('/api/v1/mcp/chat/turn').set('x-cnp-csrf', restrictedCsrf)
    .send({ message: `/deploiement ${applicationId} en prod` }).expect(200);
  assert.ok(!denied.text.includes('event: tool_result'), 'No production result may reach dev-only user');
  assert.equal(audits.filter(item => item.tool === 'get_deployment_status').length, before,
    'Unauthorized production target must not invoke deployment tool');
  console.log('PASS: real login/CSRF/SSE, native sources and MCP HTTP dev/prod; dev-only catalog and prod refusal. No cloud writes or paid AI calls.');
} catch (error) {
  console.error('Live MCP recipe failed:', error instanceof assert.AssertionError ? error.message : (error.code || error.name));
  process.exitCode = 1;
} finally {
  if (server) await server.close();
  if (database) database.close();
  await rm(temporary, { recursive: true, force: true });
}
