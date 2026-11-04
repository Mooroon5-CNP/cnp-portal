'use strict';

jest.mock('../src/services/environment-deployment', () => ({ onboard: jest.fn(), validate: jest.fn(), remove: jest.fn(), resumeAfterCleanupFailure: jest.fn(), workflowName: name => `cnp-${name}.yml` }));
const app = require('../src/index');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const service = require('../src/services/environment-deployment');
const { request, cookie } = require('./helpers/in-memory-http');
let auth;
beforeAll(async () => {
  const login = await request(app, { method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: process.env.ADMIN_INITIAL_PASSWORD }).toString() });
  auth = cookie(login);
});
beforeEach(() => {
  service.onboard.mockReset();
  service.remove.mockReset();
  service.resumeAfterCleanupFailure.mockReset();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
});
function deployment(state = 'failed', error = 'Argo API 403') {
  const dep = deployments.create({ appName: 'retry-app', githubRepoUrl: 'https://github.com/team/retry-app', environment: 'dev', ownerUserId: 'owner' });
  deployments.updateOnboardingStatus(dep.id, state, error);
  return dep;
}
test('failed configuration retries the same record and clears the old error', async () => {
  const dep = deployment(); let finish;
  service.onboard.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const response = await request(app, { method: 'POST', url: `/deployments/${dep.id}/retry-configuration`, headers: { cookie: auth } });
  expect(response.status).toBe(302);
  expect(deployments.get(dep.id)).toMatchObject({ onboardingStatus: 'configuring', onboardingError: null });
  expect(service.onboard).toHaveBeenCalledTimes(1);
  const duplicate = await request(app, { method: 'POST', url: `/deployments/${dep.id}/retry-configuration`, headers: { cookie: auth } });
  expect(duplicate.status).toBe(409);
  finish(); await new Promise(resolve => setImmediate(resolve));
  expect(deployments.get(dep.id).onboardingStatus).toBe('ready');
});
test.each([['ready', null], ['configuring', null], ['failed', 'Nettoyage partiel : forbidden']])('retry refuses %s / %s without upstream work', async (state, error) => {
  const dep = deployment(state, error);
  const response = await request(app, { method: 'POST', url: `/deployments/${dep.id}/retry-configuration`, headers: { cookie: auth } });
  expect(response.status).toBe(409);
  expect(service.onboard).not.toHaveBeenCalled();
});

test('a reader cannot retry another owner’s deployment even if it is visible', async () => {
  const dep = deployment();
  const user = require('../src/models/user').create({ username: 'retry-reader', role: 'dev', active: true, approved: true,
    passwordHash: require('bcryptjs').hashSync('fixture-password', 4) });
  const login = await request(app, { method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: user.username, password: 'fixture-password' }).toString() });
  const visible = jest.spyOn(deployments, 'listForUser').mockReturnValue([{ id: dep.id }]);
  try {
    const response = await request(app, { method: 'POST', url: `/deployments/${dep.id}/retry-configuration`, headers: { cookie: cookie(login) } });
    expect(response.status).toBe(403);
    expect(service.onboard).not.toHaveBeenCalled();
  } finally { visible.mockRestore(); }
});
test('failed retry retains the new error rather than claiming successful setup', async () => {
  const dep = deployment();
  service.onboard.mockRejectedValue(new Error('Kubernetes forbidden'));
  await request(app, { method: 'POST', url: `/deployments/${dep.id}/retry-configuration`, headers: { cookie: auth } });
  await new Promise(resolve => setImmediate(resolve));
  expect(deployments.get(dep.id)).toMatchObject({ onboardingStatus: 'failed', onboardingError: 'Kubernetes forbidden' });
});

test('partial cleanup retains the record and a second deletion can succeed', async () => {
  const dep = deployment('ready', null);
  service.remove.mockRejectedValueOnce(new Error('Kubernetes timeout')).mockResolvedValueOnce();
  await request(app, { method: 'POST', url: `/deployments/${dep.id}/delete`, headers: { cookie: auth } });
  expect(deployments.get(dep.id)).toMatchObject({ onboardingStatus: 'delete_failed', onboardingError: 'Nettoyage partiel : Kubernetes timeout' });
  const status = await request(app, { url: `/deployments/${dep.id}/status`, headers: { cookie: auth } });
  expect(status.text).toContain('delete_failed');
  await request(app, { method: 'POST', url: `/deployments/${dep.id}/delete`, headers: { cookie: auth } });
  expect(service.remove).toHaveBeenCalledTimes(2);
  expect(deployments.get(dep.id)).toBeNull();
});
test('legacy cleanup failures expose the recovery status and explicit resume route', async () => {
  const dep = deployment('failed', 'Nettoyage partiel : ArgoCD 415');
  expect(deployments.get(dep.id).onboardingStatus).toBe('delete_failed');
  const response = await request(app, { method: 'POST', url: `/deployments/${dep.id}/resume-deployment`, headers: { cookie: auth } });
  expect(response.status).toBe(302);
  expect(service.resumeAfterCleanupFailure).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id, onboardingStatus: 'delete_failed' }));
});
test('concurrent deletion is rejected without starting another cleanup', async () => {
  const dep = deployment('deleting', null);
  const response = await request(app, { method: 'POST', url: `/deployments/${dep.id}/delete`, headers: { cookie: auth } });
  expect(response.status).toBe(409);
  expect(service.remove).not.toHaveBeenCalled();
});

test('a record blocked by the removed environment import can retry normal configuration', async () => {
  const dep = deployment('failed', 'Configuration des variables impossible. Vérifiez les droits du stockage de secrets.');
  service.onboard.mockResolvedValue();
  const response = await request(app, { method: 'POST', url: `/deployments/${dep.id}/retry-configuration`, headers: { cookie: auth } });
  expect(response.status).toBe(302);
  await new Promise(resolve => setImmediate(resolve));
  expect(service.onboard).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id }));
  expect(deployments.get(dep.id)).toMatchObject({ onboardingStatus: 'ready', onboardingError: null });
});
test('creation does not require importing env or accessing Secret Manager', async () => {
  const config = require('../src/config/env').config; const previous = config.github.configRepoToken;
  config.github.configRepoToken = 'fixture-config-token'; service.onboard.mockResolvedValue();
  try {
    const response = await request(app, { method: 'POST', url: '/deployments', headers: { cookie: auth, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ appName: 'normal-app', githubRepoUrl: 'https://github.com/team/normal-app', environment: 'dev', environmentText: 'TOKEN=ignored-old-form-value' }).toString() });
    expect(response.status).toBe(302);
    await new Promise(resolve => setImmediate(resolve));
    const row = deployments.listForUser(null)[0];
    expect(row.app_name).toBe('normal-app'); expect(row.onboarding_status).toBe('ready');
    expect(service.onboard).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(row)).not.toContain('ignored-old-form-value');
  } finally { config.github.configRepoToken = previous; }
});
test('the create form has no env import or hosting selector', async () => {
  const response = await request(app, { url: '/deployments', headers: { cookie: auth } });
  expect(response.status).toBe(200);
  expect(response.text).not.toContain('name="environmentText"');
  expect(response.text).not.toContain('name="useCloudRun"');
});
