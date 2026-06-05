'use strict';

const request = require('supertest');
const app = require('../src/index');

describe('Health checks', () => {
  test('GET /healthz returns 200 with status ok', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  test('GET /ready returns 200 with status ready', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });
});

describe('Auth routes', () => {
  test('GET / redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  test('GET /auth/login renders login page', async () => {
    const res = await request(app).get('/auth/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('CNP Portal');
    expect(res.text).toContain('gitlab');
  });

  test('GET /deployments redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/deployments');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  test('GET /k8s/pods redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/k8s/pods');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  test('GET /admin/users redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/admin/users');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });
});

describe('RBAC middleware', () => {
  const { can } = require('../src/middleware/rbac');

  test('manager can do everything', () => {
    const manager = { role: 'manager' };
    expect(can(manager, 'users:list')).toBe(true);
    expect(can(manager, 'k8s:pods:delete')).toBe(true);
    expect(can(manager, 'secrets:create')).toBe(true);
    expect(can(manager, 'argocd:access:approve')).toBe(true);
  });

  test('devops cannot manage users or secrets', () => {
    const devops = { role: 'devops' };
    expect(can(devops, 'users:list')).toBe(false);
    expect(can(devops, 'users:modify-role')).toBe(false);
    expect(can(devops, 'secrets:create')).toBe(false);
    expect(can(devops, 'k8s:pods:delete')).toBe(true);
    expect(can(devops, 'argocd:sync')).toBe(true);
  });

  test('dev has limited access', () => {
    const dev = { role: 'dev' };
    expect(can(dev, 'k8s:pods:delete')).toBe(false);
    expect(can(dev, 'k8s:pods:scale')).toBe(false);
    expect(can(dev, 'observability:alerts:silence')).toBe(false);
    expect(can(dev, 'deployments:deploy')).toBe(true);
    expect(can(dev, 'docs:read')).toBe(true);
    expect(can(dev, 'observability:logs:own')).toBe(true);
  });

  test('null user cannot do anything', () => {
    expect(can(null, 'docs:read')).toBe(false);
    expect(can(undefined, 'k8s:pods:view-own')).toBe(false);
  });
});

describe('User model', () => {
  const userStore = require('../src/models/user');

  test('creates a user with dev role by default', () => {
    const user = userStore.create({
      gitlabId: 999999,
      gitlabUsername: 'test-user',
      email: 'test@example.com',
      avatarUrl: null,
    });
    expect(user.role).toBe('dev');
    expect(user.id).toBeDefined();
    expect(user.active).toBe(true);
  });

  test('finds user by id', () => {
    const created = userStore.create({ gitlabId: 888888, gitlabUsername: 'alice', email: 'alice@example.com', avatarUrl: null });
    const found = userStore.findById(created.id);
    expect(found).toBeDefined();
    expect(found.gitlabUsername).toBe('alice');
  });

  test('upserts existing gitlab user', () => {
    const first = userStore.upsertFromGitlab({ gitlabId: 777777, gitlabUsername: 'bob', email: 'bob@example.com', avatarUrl: null });
    const second = userStore.upsertFromGitlab({ gitlabId: 777777, gitlabUsername: 'bob-updated', email: 'bob@example.com', avatarUrl: null });
    expect(first.id).toBe(second.id);
    expect(second.gitlabUsername).toBe('bob-updated');
  });
});
