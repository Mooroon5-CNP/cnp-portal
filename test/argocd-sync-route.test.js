'use strict';

// POST /argocd/sync/:name is the only portal route that triggers an Argo CD write.
// Proves that no anonymous, under-privileged or out-of-scope request reaches the Argo CD client.
jest.mock('../src/clients/argocd', () => ({ syncApplication: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({}));
jest.mock('../src/models/deployment', () => ({ listForUser: jest.fn() }));

const request = require('supertest');
const express = require('express');
const path = require('path');
const client = require('../src/clients/argocd');
const deployments = require('../src/models/deployment');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../src/views'));
app.use((req, res, next) => {
  const role = req.get('X-role');
  if (role) {
    req.user = { id: 'user', username: 'test', active: req.get('X-inactive') ? false : true, role };
    req.session = { userId: req.user.id };
  }
  req.flash = jest.fn();
  res.locals.flash = {};
  res.locals.pendingMrCount = 0;
  next();
});
app.use('/argocd', require('../src/routes/argocd'));

beforeEach(() => {
  jest.resetAllMocks();
  deployments.listForUser.mockReturnValue([{ app_name: 'app4-pixelcam' }]);
  client.syncApplication.mockResolvedValue({});
});

test('unauthenticated sync is redirected to login without calling Argo CD', async () => {
  const res = await request(app).post('/argocd/sync/app4-pixelcam-dev');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/auth/login');
  expect(client.syncApplication).not.toHaveBeenCalled();
});

test('inactive account cannot sync', async () => {
  const res = await request(app).post('/argocd/sync/app4-pixelcam-dev').set('X-role', 'manager').set('X-inactive', '1');
  expect(res.headers.location).toBe('/pending');
  expect(client.syncApplication).not.toHaveBeenCalled();
});

test('dev role is refused with 403 without calling Argo CD', async () => {
  const res = await request(app).post('/argocd/sync/app4-pixelcam-dev').set('X-role', 'dev');
  expect(res.status).toBe(403);
  expect(client.syncApplication).not.toHaveBeenCalled();
});

test.each(['crossplane-providers', 'ingress-nginx', 'other-app-dev'])(
  'manager cannot sync %s, which the portal does not manage', async name => {
    await request(app).post(`/argocd/sync/${name}`).set('X-role', 'manager');
    expect(client.syncApplication).not.toHaveBeenCalled();
  },
);

test('devops can sync a portal-managed application', async () => {
  await request(app).post('/argocd/sync/app4-pixelcam-dev').set('X-role', 'devops');
  expect(client.syncApplication).toHaveBeenCalledWith('app4-pixelcam-dev');
});
