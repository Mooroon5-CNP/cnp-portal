'use strict';

const app = require('../src/index');
const { request, cookie } = require('./helpers/in-memory-http');

afterEach(() => jest.restoreAllMocks());

test('local admin login renews its cookie and opens an authenticated page', async () => {
  const page = await request(app, { url: '/auth/login' });
  expect(page.status).toBe(200);
  const before = cookie(page);
  const login = await request(app, { method: 'POST', url: '/auth/login',
    headers: { cookie: before, origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: process.env.ADMIN_INITIAL_PASSWORD }).toString() });
  expect(login.status).toBe(302);
  expect(login.headers.location).toBe('/');
  expect(cookie(login)).toBeTruthy();
  expect(cookie(login)).not.toBe(before);
  const profile = await request(app, { url: '/profile', headers: { cookie: cookie(login) } });
  expect(profile.status).toBe(200);
  expect(profile.text).toContain('admin');
});

test('wrong local credentials render the failure message', async () => {
  const result = await request(app, { method: 'POST', url: '/auth/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'incorrect-password' }).toString() });
  expect(result.headers.location).toBe('/auth/login');
  const page = await request(app, { url: '/auth/login', headers: { cookie: cookie(result) } });
  expect(page.text).toContain('Identifiant ou mot de passe incorrect.');
});


test('admin reaches the dashboard when a cloud provider never responds', async () => {
  jest.spyOn(require('../src/services/k8s'), 'listPods').mockReturnValue(new Promise(() => {}));
  jest.spyOn(require('../src/services/datadog'), 'getAlerts').mockResolvedValue([]);
  jest.spyOn(require('../src/services/argocd'), 'listApps').mockReturnValue(new Promise(() => {}));
  const login = await request(app, { method: 'POST', url: '/auth/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001' },
    body: new URLSearchParams({ username: 'admin', password: process.env.ADMIN_INITIAL_PASSWORD }).toString() });
  expect(login.headers.location).toBe('/');
  const dashboard = await request(app, { headers: { cookie: cookie(login) } });
  expect(dashboard.status).toBe(200);
  expect(dashboard.text).toContain('Bienvenue, admin');
  expect(dashboard.text).toContain('Données temporairement indisponibles : Kubernetes, Argo CD');
  expect(dashboard.text).toContain('— apps gérées');
}, 10000);
