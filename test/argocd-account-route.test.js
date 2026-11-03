'use strict';

const app = require('../src/index');
const db = require('../src/models/db');
const requests = require('../src/models/argocd_access_request');
const service = require('../src/services/argocd');
const kubernetes = require('../src/clients/kubernetes');
const { request, cookie } = require('./helpers/in-memory-http');

afterEach(() => jest.restoreAllMocks());

test('an approved manager sees their own Argo credentials after a duplicate request', async () => {
  const manager = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  const access = requests.create({ userId: manager.id, appName: null, reason: 'Personal Argo account' });
  jest.spyOn(kubernetes, 'provisionArgoCDLocalUser').mockResolvedValue();
  jest.spyOn(service, 'listApps').mockResolvedValue([]);
  requests.approve(access.id, { argoCDUsername: 'admin', argoCDPassword: 'historical-unreadable-ciphertext', reviewedBy: 'historical-reviewer' });
  await service.regenerateCredentials(manager.id);
  const credentials = service.getUserAccessRequest(manager.id);
  expect(credentials.argoCDPassword).toBeTruthy();

  const login = await request(app, { method: 'POST', url: '/auth/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: process.env.ADMIN_INITIAL_PASSWORD }).toString() });
  const duplicate = await request(app, { method: 'POST', url: '/argocd/access-request',
    headers: { cookie: cookie(login), 'content-type': 'application/x-www-form-urlencoded' },
    body: 'reason=again' });
  expect(duplicate.headers.location).toBe('/argocd?voir=identifiants');
  const page = await request(app, { url: duplicate.headers.location, headers: { cookie: cookie(login) } });
  expect(page.status).toBe(200);
  expect(page.text).toContain('Vous avez déjà un accès ArgoCD approuvé.');
  expect(page.text).toContain('id="mes-identifiants"');
  expect(page.text).toContain('id="argocd-pwd-toggle"');
  expect(page.text).toContain(`value="${credentials.argoCDPassword}"`);
  expect(page.text).not.toContain("Vous n'avez pas encore accès à ArgoCD.");
  expect(kubernetes.provisionArgoCDLocalUser).toHaveBeenCalledTimes(1);
});

test('a forged self-approval POST is refused before provisioning or storing credentials', async () => {
  const manager = db.prepare("SELECT id FROM users WHERE username = 'admin'").get();
  const access = requests.create({ userId: manager.id, appName: null, reason: 'Must not self approve' });
  const provision = jest.spyOn(kubernetes, 'provisionArgoCDLocalUser').mockResolvedValue();
  const login = await request(app, { method: 'POST', url: '/auth/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: process.env.ADMIN_INITIAL_PASSWORD }).toString() });
  const approval = await request(app, { method: 'POST', url: `/argocd/access-request/${access.id}/approve`,
    headers: { cookie: cookie(login) } });
  expect(approval.status).toBe(403);
  expect(approval.text).toContain('aucune auto-approbation');
  expect(provision).not.toHaveBeenCalled();
  expect(requests.getById(access.id).status).toBe('pending');
  expect(requests.getById(access.id).argoCDPassword).toBeNull();
});
