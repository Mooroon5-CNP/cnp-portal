'use strict';
jest.mock('../src/services/environment-deployment', () => ({ onboard: jest.fn(), triggerConfigurationBuild: jest.fn(), validate: jest.fn(), reconcile: jest.fn(), workflowName: name => `cnp-${name}.yml` }));
jest.mock('../src/clients/github', () => ({ checkActionsEnabled: jest.fn(), getRuns: jest.fn().mockResolvedValue([]), getRunJobs: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/clients/secret-manager', () => ({ capability: jest.fn(), prepare: jest.fn(), store: jest.fn(), runtimeAccount: () => 'isolated@test-project.iam.gserviceaccount.com' }));
const app = require('../src/index');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const vars = require('../src/models/deployment-environment');
const provider = require('../src/clients/secret-manager');
const engine = require('../src/services/environment-deployment');
const github = require('../src/clients/github');
const { config } = require('../src/config/env');
const { request, cookie } = require('./helpers/in-memory-http');
let auth; let reader; let adminId;
beforeAll(async () => {
  config.github.configRepoToken = 'fixture-config-token';
  adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  async function login(username, password) {
    return cookie(await request(app, { method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }).toString() }));
  }
  auth = await login('admin', process.env.ADMIN_INITIAL_PASSWORD);
  require('../src/models/user').create({ username: 'variable-reader', role: 'dev', active: true, approved: true, passwordHash: require('bcryptjs').hashSync('fixture-password', 4) });
  reader = await login('variable-reader', 'fixture-password');
});
beforeEach(() => {
  jest.clearAllMocks();
  for (const table of ['deployment_team_access', 'deployments', 'deployment_environment_refs', 'deployment_configuration_locks']) db.prepare(`DELETE FROM ${table}`).run();
  provider.capability.mockResolvedValue({ available: true, code: 'READY', message: 'Ready' });
  provider.prepare.mockResolvedValue(); provider.store.mockImplementation(async (_dep, name) => ({ name, valueSource: { secretKeyRef: { secret: 'managed-secret', version: '2' } } }));
  github.checkActionsEnabled.mockResolvedValue(); engine.onboard.mockResolvedValue(); engine.triggerConfigurationBuild.mockResolvedValue(); engine.reconcile.mockResolvedValue({ phase: 'approval' });
});
function post(url, params, session = auth, headers = {}) {
  return request(app, { method: 'POST', url, headers: { cookie: session, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(params).toString() });
}
function input(value = 'private-runtime-value') { return { appName: 'wizard-app', githubRepoUrl: 'https://github.com/team/wizard-app', environment: 'dev', variableName: 'GITHUB_CLIENT_SECRET', variableValue: value, variableAction: 'set' }; }
function existing() {
  const dep = deployments.create({ appName: 'wizard-app', githubRepoUrl: 'https://github.com/team/wizard-app', environment: 'prod', ownerUserId: adminId });
  deployments.updateOnboardingStatus(dep.id, 'ready'); return deployments.get(dep.id);
}
test('form renders three steps, optional variables and no .env import or hosting selector', async () => {
  const response = await request(app, { url: '/deployments', headers: { cookie: auth } });
  expect(response.status).toBe(200);
  for (const step of [1, 2, 3]) expect(response.text).toContain(`data-deployment-step="${step}"`);
  expect(response.text).toContain('Suivant'); expect(response.text).toContain('Ajouter une variable');
  expect(response.text).not.toContain('name="environmentText"'); expect(response.text).not.toContain('name="useCloudRun"');
});
test('without variables, no identity/permission check is required and onboarding is unchanged', async () => {
  provider.capability.mockResolvedValue({ available: false });
  const response = await post('/deployments', { appName: 'simple-app', githubRepoUrl: 'https://github.com/team/simple-app' });
  expect(response.status).toBe(202); await new Promise(resolve => setImmediate(resolve));
  expect(engine.onboard).toHaveBeenCalledTimes(1); expect(provider.capability).not.toHaveBeenCalled();
});
test('platform unavailable creates no failed record, no secrets and no CI', async () => {
  provider.capability.mockResolvedValue({ available: false, message: 'Platform not ready' });
  const response = await post('/deployments', input());
  expect(response.status).toBe(503); expect(response.text).not.toContain('private-runtime-value');
  expect(deployments.listForUser(null)).toHaveLength(0); expect(provider.store).not.toHaveBeenCalled(); expect(engine.onboard).not.toHaveBeenCalled();
});
test('provider write failures also leave no record and do not echo request payloads', async () => {
  provider.store.mockRejectedValue(new Error('private-runtime-value from upstream'));
  const response = await post('/deployments', input());
  expect(response.status).toBe(503); expect(response.text).not.toContain('private-runtime-value'); expect(deployments.listForUser(null)).toHaveLength(0);
});
test('successful creation persists only references and starts the normal CI onboarding', async () => {
  const response = await post('/deployments', input());
  expect(response.status).toBe(202); expect(response.text).not.toContain('private-runtime-value');
  await new Promise(resolve => setImmediate(resolve));
  const row = deployments.listForUser(null)[0]; expect(row.onboarding_status).toBe('ready');
  const metadata = db.prepare('SELECT * FROM deployment_environment_refs WHERE deployment_id=?').get(row.id);
  expect(JSON.stringify(metadata)).not.toContain('private-runtime-value'); expect(vars.get(row.id)[0].valueSource.secretKeyRef.version).toBe('2');
  expect(engine.onboard).toHaveBeenCalledWith(expect.objectContaining({ id: row.id }));
});
test('duplicates are rejected before cloud provisioning', async () => {
  existing(); const response = await post('/deployments', { ...input(), environment: 'prod' });
  expect(response.status).toBe(409); expect(provider.store).not.toHaveBeenCalled();
});
test('invalid names, duplicates, reserved keys and Azure variables are rejected before provisioning', async () => {
  for (const params of [{ ...input(), variableName: 'PORT' }, { ...input(), variableName: 'BAD KEY' }, { ...input(), targetCluster: 'azure' }]) {
    expect((await post('/deployments', params)).status).toBe(400);
  }
  const params = new URLSearchParams(input()); params.append('variableName', 'GITHUB_CLIENT_SECRET'); params.append('variableValue', 'other'); params.append('variableAction', 'set');
  expect((await post('/deployments', params)).status).toBe(400); expect(provider.store).not.toHaveBeenCalled();
});
test('capability endpoint exposes no credentials and does not provision anything', async () => {
  const response = await request(app, { url: '/deployments/variables/capability', headers: { cookie: auth } });
  expect(response.status).toBe(200); expect(JSON.parse(response.text).available).toBe(true); expect(response.headers['cache-control']).toBe('no-store'); expect(provider.prepare).not.toHaveBeenCalled();
});
test('production updates only prepare a new CI; values are never sent back on detail', async () => {
  const dep = existing();
  const response = await post(`/deployments/${dep.id}/variables`, input()); expect(response.status).toBe(200);
  expect(engine.triggerConfigurationBuild).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id, environment: 'prod' }), expect.any(Function));
  const detail = await request(app, { url: `/deployments/${dep.id}`, headers: { cookie: auth } });
  expect(detail.status).toBe(200); expect(detail.text).toContain('GITHUB_CLIENT_SECRET'); expect(detail.text).not.toContain('private-runtime-value');
});
test('a reader cannot modify variables even if the deployment is visible', async () => {
  const dep = existing(); const visible = jest.spyOn(deployments, 'listForUser').mockReturnValue([{ id: dep.id }]);
  try { expect((await post(`/deployments/${dep.id}/variables`, input(), reader)).status).toBe(403); }
  finally { visible.mockRestore(); }
  expect(provider.store).not.toHaveBeenCalled();
});
test('CI failure rolls back references; cross-origin and production HTTP writes are refused', async () => {
  const dep = existing(); const old = [{ name: 'TOKEN', valueSource: { secretKeyRef: { secret: 'old-secret', version: '1' } } }]; vars.save(dep.id, old);
  engine.triggerConfigurationBuild.mockRejectedValue(new Error('GitHub unavailable'));
  expect((await post(`/deployments/${dep.id}/variables`, input())).status).toBe(503); expect(vars.get(dep.id)).toEqual(old);
  provider.store.mockClear();
  expect((await post(`/deployments/${dep.id}/variables`, input(), auth, { origin: 'https://attacker.test' })).status).toBe(403);
  const previous = process.env.NODE_ENV;
  try { process.env.NODE_ENV = 'production'; expect((await post(`/deployments/${dep.id}/variables`, input())).status).toBe(400); }
  finally { process.env.NODE_ENV = previous; }
  expect(provider.store).not.toHaveBeenCalled();
});

test('multiline values are sent intact to the provider and never echoed or persisted', async () => {
  const value = 'fixture-line-one\nfixture-line-two';
  const response = await post('/deployments', input(value));
  expect(response.status).toBe(202); expect(response.text).not.toContain('fixture-line-one');
  expect(provider.store).toHaveBeenCalledWith(expect.any(Object), 'GITHUB_CLIENT_SECRET', value);
  const row = deployments.listForUser(null)[0];
  expect(JSON.stringify(db.prepare('SELECT * FROM deployment_environment_refs WHERE deployment_id=?').get(row.id))).not.toContain('fixture-line-one');
});
