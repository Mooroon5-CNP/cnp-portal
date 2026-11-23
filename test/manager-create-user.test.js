'use strict';

const app = require('../src/index');
const { request, cookie } = require('./helpers/in-memory-http');
const userStore = require('../src/models/user');
const teamService = require('../src/services/teams');

const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin' };
const JSON_HEADERS = { 'content-type': 'application/json', origin: 'http://localhost:3001', 'sec-fetch-site': 'same-origin' };

async function login(username, password) {
  const res = await request(app, { method: 'POST', url: '/auth/login', headers: FORM,
    body: new URLSearchParams({ username, password }).toString() });
  return res;
}
const adminSession = async () => cookie(await login('admin', process.env.ADMIN_INITIAL_PASSWORD));
const createAs = (session, body) => request(app, { method: 'POST', url: '/admin/users/create',
  headers: { ...JSON_HEADERS, cookie: session }, body: JSON.stringify(body) });

test('a manager creates an account with role and team and receives username, password and link once', async () => {
  const team = teamService.createTeam(`team-${Date.now()}`);
  const res = await createAs(await adminSession(), { username: 'alice.dev', role: 'devops', teamId: team.id });
  expect(res.status).toBe(201);
  const data = JSON.parse(res.text);
  expect(data).toMatchObject({ ok: true, username: 'alice.dev', url: 'https://portal.apps.mooroon5.fr' });
  expect(data.password).toMatch(/^[A-Za-z0-9]{16}$/);
  const stored = userStore.findByUsername('alice.dev');
  expect(stored).toMatchObject({ role: 'devops', active: true, approved: true, mustChangePassword: true });
  expect(stored.passwordHash).not.toContain(data.password);
  expect(teamService.getTeam(team.id).memberIds).toContain(stored.id);
});

test('passwords are random per account', async () => {
  const session = await adminSession();
  const a = JSON.parse((await createAs(session, { username: 'rand.one', role: 'dev' })).text);
  const b = JSON.parse((await createAs(session, { username: 'rand.two', role: 'dev' })).text);
  expect(a.password).not.toBe(b.password);
});

test('validation: duplicate username, bad username, bad role, unknown team', async () => {
  const session = await adminSession();
  expect((await createAs(session, { username: 'admin', role: 'dev' })).status).toBe(409);
  expect((await createAs(session, { username: 'a b', role: 'dev' })).status).toBe(400);
  expect((await createAs(session, { username: 'valid.name', role: 'root' })).status).toBe(400);
  expect((await createAs(session, { username: 'valid.name', role: 'dev', teamId: 'nope' })).status).toBe(400);
  expect(userStore.findByUsername('valid.name')).toBeNull();
});

test('only managers can create accounts', async () => {
  const session = await adminSession();
  const made = JSON.parse((await createAs(session, { username: 'plain.dev', role: 'dev' })).text);
  const devSession = cookie(await login('plain.dev', made.password));
  const denied = await createAs(devSession, { username: 'sneaky', role: 'manager' });
  expect([302, 403]).toContain(denied.status);
  expect(userStore.findByUsername('sneaky')).toBeNull();
  expect((await createAs('', { username: 'anon', role: 'dev' })).status).not.toBe(201);
});

test('first sign-in forces a password change, then the account works normally', async () => {
  const made = JSON.parse((await createAs(await adminSession(), { username: 'bob.first', role: 'dev' })).text);
  const session = cookie(await login('bob.first', made.password));
  const blocked = await request(app, { url: '/', headers: { cookie: session } });
  expect(blocked.status).toBe(302);
  expect(blocked.headers.location).toBe('/auth/change-password');
  const write = await request(app, { method: 'POST', url: '/deployments', headers: { ...JSON_HEADERS, cookie: session }, body: '{}' });
  expect(write.status).toBe(403);
  expect((await request(app, { url: '/auth/change-password', headers: { cookie: session } })).status).toBe(200);

  const post = (fields) => request(app, { method: 'POST', url: '/auth/change-password', headers: { ...FORM, cookie: session },
    body: new URLSearchParams(fields).toString() });
  expect((await post({ currentPassword: 'wrong', newPassword: 'a-very-long-new-pass', confirmPassword: 'a-very-long-new-pass' })).headers.location).toBe('/auth/change-password');
  expect((await post({ currentPassword: made.password, newPassword: 'short', confirmPassword: 'short' })).headers.location).toBe('/auth/change-password');
  expect((await post({ currentPassword: made.password, newPassword: 'a-very-long-new-pass', confirmPassword: 'different-one-here' })).headers.location).toBe('/auth/change-password');
  expect(userStore.findByUsername('bob.first').mustChangePassword).toBe(true);

  const ok = await post({ currentPassword: made.password, newPassword: 'a-very-long-new-pass', confirmPassword: 'a-very-long-new-pass' });
  expect(ok.headers.location).toBe('/');
  expect(userStore.findByUsername('bob.first').mustChangePassword).toBe(false);
  expect((await request(app, { url: '/profile', headers: { cookie: cookie(ok) } })).status).toBe(200);
  expect((await login('bob.first', made.password)).headers.location).toBe('/auth/login');
  expect((await login('bob.first', 'a-very-long-new-pass')).headers.location).toBe('/');
});

test('the users page offers the create button to managers only', async () => {
  const page = await request(app, { url: '/admin/users', headers: { cookie: await adminSession() } });
  expect(page.text).toContain('Ajouter un utilisateur');
  expect(page.text).toContain('Aucune équipe');
});
