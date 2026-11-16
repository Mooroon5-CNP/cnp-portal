'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoToken: 'test' }, gcp: {} } }));
jest.mock('../src/clients/github', () => ({}));
jest.mock('../src/clients/kubernetes', () => ({}));
jest.mock('../src/services/environment-deployment', () => ({ validate: jest.fn(), onboard: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/repository-database', () => ({ assertCompatible: jest.fn() }));
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const guard = require('../src/services/repository-database');
const environment = require('../src/services/environment-deployment');
const router = require('../src/routes/deployments');
const user = require('../src/models/user').findByUsername('admin');
beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
  guard.assertCompatible.mockResolvedValue({ engine: 'unknown' });
});
async function submit(stack, environment = 'dev') {
  const req = { body: { appName: 'guard-app', githubRepoUrl: 'https://github.com/team/guard-app', appPort: '8080', stack, environment },
    user, session: {}, flash: jest.fn() };
  const res = { redirect: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
  await router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack.at(-1).handle(req, res);
  await Promise.resolve();
  return { req, res };
}

test.each(['gcp-sqlite', 'gcp-postgres', 'azure-postgres'])('a mismatch for %s creates no deployment and starts no onboarding', async stack => {
  guard.assertCompatible.mockRejectedValueOnce(new Error('SQLite/PostgreSQL incompatibles'));
  const { req, res } = await submit(stack);
  expect(deployments.listForUser(null)).toHaveLength(0);
  expect(environment.onboard).not.toHaveBeenCalled();
  expect(res.redirect).toHaveBeenCalledWith('/deployments');
  expect(req.session.deploymentDraft).toMatchObject({ appName: 'guard-app', stack, githubRepoUrl: 'https://github.com/team/guard-app' });
  expect(req.flash).toHaveBeenCalledWith('error', 'SQLite/PostgreSQL incompatibles');
});

test.each([
  ['gcp-sqlite', 'dev', 'sqlite'], ['gcp-postgres', 'dev', 'postgres'],
  ['gcp-postgres', 'prod', 'postgres'], ['azure-postgres', 'dev', 'postgres'],
])('matching %s / %s is checked before creating the deployment', async (stack, env, selected) => {
  guard.assertCompatible.mockImplementation(async () => {
    expect(deployments.listForUser(null)).toHaveLength(0);
    return { engine: selected };
  });
  await submit(stack, env);
  expect(guard.assertCompatible).toHaveBeenCalledWith({ owner: 'team', repo: 'guard-app' }, { environment: env, selected });
  expect(deployments.listForUser(null)).toHaveLength(1);
  expect(environment.onboard).toHaveBeenCalledTimes(1);
});

test('correcting the choice after refusal succeeds without deleting any record', async () => {
  guard.assertCompatible.mockRejectedValueOnce(new Error('Dépôt SQLite, sélection PostgreSQL'));
  await submit('gcp-postgres');
  expect(deployments.listForUser(null)).toHaveLength(0);
  await submit('gcp-sqlite');
  expect(deployments.listForUser(null)).toHaveLength(1);
  expect(deployments.get(deployments.listForUser(null)[0].id).persistentStorage).toBe(true);
});

test('the refused form reopens with its values and diagnostic, without creating a record', async () => {
  guard.assertCompatible.mockRejectedValueOnce(new Error('Dépôt SQLite, sélection PostgreSQL'));
  const { req } = await submit('gcp-postgres');
  req.query = {};
  const res = { render: jest.fn() };
  await router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get).route.stack.at(-1).handle(req, res);
  const locals = res.render.mock.calls[0][1];
  expect(locals.deploymentDraft).toMatchObject({ appName: 'guard-app', stack: 'gcp-postgres' });
  const html = await require('ejs').renderFile(require('path').join(__dirname, '../src/views/deployments/index.ejs'), {
    ...locals, flash: {}, pendingMrCount: 0, rejectedMrCount: 0,
  });
  expect(html).toContain('value="guard-app"');
  expect(html).toContain('value="https://github.com/team/guard-app"');
  expect(html).toContain('Dépôt SQLite, sélection PostgreSQL');
  expect(html).toContain('showModal();');
  expect(req.session.deploymentDraft).toBeUndefined();
  expect(deployments.listForUser(null)).toHaveLength(0);
});
