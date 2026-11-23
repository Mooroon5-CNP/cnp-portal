'use strict';

const app = require('../src/index');
const db = require('../src/models/db');
const { request, cookie } = require('./helpers/in-memory-http');
const userStore = require('../src/models/user');
const deletionRequests = require('../src/models/deletion_request');
const argocdRequests = require('../src/models/argocd_access_request');
const { managerRequestCounts } = require('../src/services/request-badges');

const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin' };
const badgeAfter = (html, label) => {
  const start = html.indexOf(label);
  if (start < 0) return null;
  const end = html.indexOf('</a>', start);
  const match = html.slice(start, end).match(/font-size:11px;font-weight:700;">(\d+)<\/span>/);
  return match ? Number(match[1]) : 0;
};
async function sessionFor(username, password) {
  return cookie(await request(app, { method: 'POST', url: '/auth/login', headers: FORM,
    body: new URLSearchParams({ username, password }).toString() }));
}

test('managers get one badge per request type, summed per sidebar entry; zero shows nothing', async () => {
  const session = await sessionFor('admin', process.env.ADMIN_INITIAL_PASSWORD);
  const before = await request(app, { url: '/profile', headers: { cookie: session } });
  expect(badgeAfter(before.text, 'Utilisateurs')).toBe(0);
  expect(badgeAfter(before.text, 'ArgoCD')).toBe(0);
  expect(badgeAfter(before.text, 'Déploiements')).toBe(0);

  userStore.create({ username: 'waiting.one', approved: 0, active: 0 });
  userStore.create({ username: 'waiting.two', approved: 0, active: 0 });
  argocdRequests.create({ userId: 'u-1', appName: 'app', reason: 'need access' });
  deletionRequests.create({ deploymentId: 'd-1', requestedBy: 'u-1', reason: 'cleanup' });
  db.prepare("INSERT INTO deployment_releases (deployment_id, revision, run_id, state) VALUES ('d-2', 'r1', 1, 'pending')").run();
  db.prepare("INSERT INTO deployment_releases (deployment_id, revision, run_id, state) VALUES ('d-3', 'r1', 2, 'published')").run();

  const after = await request(app, { url: '/profile', headers: { cookie: session } });
  expect(badgeAfter(after.text, 'Utilisateurs')).toBe(2);
  expect(badgeAfter(after.text, 'ArgoCD')).toBe(1);
  expect(badgeAfter(after.text, 'Déploiements')).toBe(2); // 1 deletion + 1 production approval
  expect(managerRequestCounts({ role: 'manager' })).toEqual({ users: 2, deployments: 2, argocd: 1 });
});

test('non-managers never see request counts', () => {
  expect(managerRequestCounts({ role: 'dev' })).toEqual({ users: 0, deployments: 0, argocd: 0 });
  expect(managerRequestCounts({ role: 'devops' })).toEqual({ users: 0, deployments: 0, argocd: 0 });
  expect(managerRequestCounts(null)).toEqual({ users: 0, deployments: 0, argocd: 0 });
});

test('a failing counter degrades to zero instead of breaking the page', () => {
  const spy = jest.spyOn(userStore, 'countPending').mockImplementation(() => { throw new Error('db down'); });
  expect(managerRequestCounts({ role: 'manager' }).users).toBe(0);
  spy.mockRestore();
});
