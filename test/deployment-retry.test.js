'use strict';

jest.mock('../src/services/environment-deployment', () => ({ onboard: jest.fn(), workflowName: name => `cnp-${name}.yml` }));
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
