'use strict';

jest.mock('../src/config/env', () => ({ config: { github: {}, gcp: {} } }));
jest.mock('../src/clients/github', () => ({}));
jest.mock('../src/clients/kubernetes', () => ({}));
jest.mock('../src/services/environment-deployment', () => ({}));
jest.mock('../src/services/environment-deletion', () => ({ start: jest.fn(), get: jest.fn() }));
jest.mock('../src/services/onboarding', () => ({ offboardApp: jest.fn() }));
jest.mock('../src/services/environment-failover', () => ({ enabled: () => false }));

const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const requests = require('../src/models/deletion_request');
const cleanup = require('../src/services/environment-deletion');
const user = require('../src/models/user').findByUsername('admin');
const router = require('../src/routes/deployments');
let dep;

beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM deletion_requests').run();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
  dep = deployments.create({ appName: 'delete-app', environment: 'dev', persistentStorage: true,
    githubRepoUrl: 'https://github.com/team/delete-app', ownerUserId: user.id });
  cleanup.start.mockImplementation(dep => deployments.updateOnboardingStatus(dep.id, 'deleting'));
});

// Invoke the route after its auth/permission middleware; no listening socket is needed.
async function invoke(path, body) {
  const req = { params: { id: dep.id }, body, user, session: {}, flash: jest.fn() };
  const res = { statusCode: 200, status: jest.fn(function(code) { this.statusCode = code; return this; }),
    send: jest.fn(), redirect: jest.fn() };
  const route = router.stack.find(layer => layer.route?.path === path).route;
  await route.stack.at(-1).handle(req, res);
  return { req, res };
}

test.each(['/:id/delete', '/:id/approve-delete'])('%s refuses a missing confirmation before any side effect', async path => {
  const pending = requests.create({ deploymentId: dep.id, requestedBy: user.id });
  const { req, res } = await invoke(path, { destroyData: 'yes' });
  expect(res.redirect).toHaveBeenCalledWith(`/deployments/${dep.id}`);
  expect(res.send).not.toHaveBeenCalled();
  expect(req.session.deletionDraft).toMatchObject({ id: dep.id, error: expect.stringContaining('Saisissez delete') });
  expect(cleanup.start).not.toHaveBeenCalled();
  expect(requests.listForDeployment(dep.id).find(row => row.id === pending.id).status).toBe('pending');
});

test.each(['/:id/delete', '/:id/approve-delete'])('%s requires explicit consent to delete persistent data', async path => {
  const { req, res } = await invoke(path, { confirmation: 'delete' });
  expect(res.redirect).toHaveBeenCalledWith(`/deployments/${dep.id}`);
  expect(res.send).not.toHaveBeenCalled();
  expect(req.session.deletionDraft).toMatchObject({ id: dep.id, action: path.includes('approve') ? 'approve' : 'delete', error: expect.stringContaining('données') });
  expect(req.flash).toHaveBeenCalledWith('error', expect.stringContaining('données'));
  expect(cleanup.start).not.toHaveBeenCalled();
});

test.each(['/:id/delete', '/:id/approve-delete'])('%s starts the same durable deletion and retains the deployment during cleanup', async path => {
  const { res } = await invoke(path, { confirmation: 'DELETE', destroyData: 'yes' });
  expect(res.redirect).toHaveBeenCalledWith(`/deployments/${dep.id}`);
  expect(cleanup.start).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id }), user, { destroyData: true });
  expect(deployments.get(dep.id).onboardingStatus).toBe('deleting');
});

test('double submission of a running deletion does not create or reset a cleanup job', async () => {
  deployments.updateOnboardingStatus(dep.id, 'deleting');
  await invoke('/:id/delete', { confirmation: 'delete', destroyData: 'yes' });
  expect(cleanup.start).not.toHaveBeenCalled();
});

test('a start failure keeps the record and shows the actual diagnostic', async () => {
  cleanup.start.mockImplementationOnce(() => { throw new Error('Cannot persist cleanup'); });
  await invoke('/:id/delete', { confirmation: 'delete', destroyData: 'yes' });
  expect(deployments.get(dep.id)).toMatchObject({ onboardingStatus: 'delete_failed', onboardingError: 'Cannot persist cleanup' });
});


test.each(['/:id/delete', '/:id/approve-delete'])('%s returns list submissions to the list dialog', async path => {
  const { req, res } = await invoke(path, { confirmation: 'delete', returnTo: 'list' });
  expect(res.redirect).toHaveBeenCalledWith('/deployments');
  expect(req.session.deletionDraft).toMatchObject({ id: dep.id });
  expect(cleanup.start).not.toHaveBeenCalled();
});

test('a forged return target cannot redirect outside the portal', async () => {
  const { res } = await invoke('/:id/delete', { confirmation: 'delete', returnTo: 'https://example.test' });
  expect(res.redirect).toHaveBeenCalledWith(`/deployments/${dep.id}`);
});

test('data consent is not required for an environment without persistent storage', async () => {
  db.prepare('UPDATE deployments SET persistent_storage=0 WHERE id=?').run(dep.id);
  await invoke('/:id/delete', { confirmation: 'delete' });
  expect(cleanup.start).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id }), user, { destroyData: false });
});

async function renderGet(req, routePath) {
  req.query = {};
  const res = { render: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
  await router.stack.find(layer => layer.route?.path === routePath && layer.route.methods.get).route.stack.at(-1).handle(req, res);
  const [view, locals] = res.render.mock.calls[0];
  const html = await require('ejs').renderFile(require('path').join(__dirname, '../src/views', `${view}.ejs`), {
    ...locals, flash: {}, pendingMrCount: 0, rejectedMrCount: 0,
  });
  return { html, locals };
}

test('the actual detail route exposes storage consent and reopens the rejected dialog', async () => {
  const { req } = await invoke('/:id/delete', { confirmation: 'delete' });
  const { html, locals } = await renderGet(req, '/:id');
  expect(locals.deployment.persistentStorage).toBe(true);
  expect(html).toContain('id="deleteBucketAck" style="display:block');
  expect(html).toMatch(/id="deleteBucketAckCheck"[^>]*name="destroyData"[^>]*required/);
  expect(html).toContain('Confirmez la suppression définitive des données');
  expect(html).toContain("document.getElementById('deleteModal').style.display = 'flex'");
  expect(req.session.deletionDraft).toBeUndefined();
  expect(cleanup.start).not.toHaveBeenCalled();
});

test('approval validation reopens the approval dialog with consent still unchecked', async () => {
  const { req } = await invoke('/:id/approve-delete', { confirmation: 'delete' });
  const { html } = await renderGet(req, '/:id');
  expect(html).toContain("document.getElementById('approveDeleteModal').style.display = 'flex'");
  const checkbox = html.match(/<input[^>]*id="approveBucketAckCheck"[^>]*>/)[0];
  expect(checkbox).toContain('required');
  expect(checkbox).not.toMatch(/\schecked(?:\s|=|>)/);
});

test('list validation reopens the correct application dialog with its storage flag', async () => {
  const { req } = await invoke('/:id/delete', { confirmation: 'delete', returnTo: 'list' });
  const { html } = await renderGet(req, '/');
  expect(html).toContain('id="deletion-retry"');
  expect(html).toContain(`data-id="${dep.id}"`);
  expect(html).toContain('data-storage="true"');
  expect(html).toContain('Confirmez la suppression définitive des données');
  expect(html).toContain('name="returnTo" value="list"');
  expect(req.session.deletionDraft).toBeUndefined();
});
