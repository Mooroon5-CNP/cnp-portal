'use strict';

jest.mock('../src/models/user', () => ({ findById: jest.fn(), findByUsername: jest.fn() }));
jest.mock('bcryptjs', () => ({ compare: jest.fn().mockResolvedValue(true) }));
const users = require('../src/models/user');
const { requireAuth } = require('../src/middleware/auth');
const router = require('../src/routes/auth');
const login = router.stack.find(layer => layer.route?.path === '/login' && layer.route.methods.post).route.stack.at(-1).handle;

test('a stale session referencing a deleted user cannot enter authenticated routes', () => {
  const next = jest.fn(); const res = { redirect: jest.fn() };
  requireAuth({ session: { userId: 'deleted' }, user: null }, res, next);
  expect(res.redirect).toHaveBeenCalledWith('/auth/login');
  expect(next).not.toHaveBeenCalled();
});
test('successful login regenerates the session before attaching identity', async () => {
  const user = { id: 'user', role: 'dev', username: 'reader', active: true, passwordHash: 'hash' };
  users.findByUsername.mockReturnValue(user);
  const oldSession = { userId: 'old', mcpConfirmedContexts: { stale: true } };
  const req = { body: { username: 'reader', password: 'password' }, session: oldSession, flash: jest.fn() };
  const save = jest.fn(callback => callback());
  oldSession.regenerate = jest.fn(callback => { req.session = { save }; callback(); });
  const res = { redirect: jest.fn() }; const next = jest.fn();
  await login(req, res, next);
  expect(oldSession.regenerate).toHaveBeenCalledTimes(1);
  expect(req.session.userId).toBe(user.id);
  expect(req.session.mcpConfirmedContexts).toBeUndefined();
  expect(save).toHaveBeenCalled();
  expect(res.redirect).toHaveBeenCalledWith('/');
  expect(next).not.toHaveBeenCalled();
});
test('session renewal failure never authenticates the old session', async () => {
  const error = new Error('session unavailable');
  const session = { regenerate: callback => callback(error) };
  const req = { body: { username: 'reader', password: 'password' }, session, flash: jest.fn() };
  users.findByUsername.mockReturnValue({ id: 'user', active: true, passwordHash: 'hash' });
  const next = jest.fn(); const res = { redirect: jest.fn() };
  await login(req, res, next);
  expect(next).toHaveBeenCalledWith(error);
  expect(session.userId).toBeUndefined();
  expect(res.redirect).not.toHaveBeenCalled();
});

test.each(['dev', 'devops'])('profile cannot promote a %s account to manager', role => {
  const profile = require('../src/routes/profile');
  const guard = profile.stack.find(layer => layer.route?.path === '/role').route.stack[1].handle;
  const next = jest.fn();
  const res = { status: jest.fn(), render: jest.fn() }; res.status.mockReturnValue(res);
  guard({ user: { id: 'user', role }, body: { role: 'manager' } }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
test('deleted accounts lose stale session identity during population', () => {
  const { populateUser } = require('../src/middleware/auth');
  users.findById.mockReturnValue(null);
  const req = { session: { userId: 'deleted', role: 'manager', username: 'old' } };
  const next = jest.fn();
  populateUser(req, {}, next);
  expect(req.session.userId).toBeUndefined();
  expect(req.session.role).toBeUndefined();
  expect(next).toHaveBeenCalled();
});

test('production refuses a missing session signing key', () => {
  const previous = process.env.NODE_ENV; const secret = process.env.SESSION_SECRET;
  try {
    process.env.NODE_ENV = 'production'; delete process.env.SESSION_SECRET;
    expect(() => jest.isolateModules(() => require('../src/config/session'))).toThrow('SESSION_SECRET');
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous;
    if (secret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = secret;
  }
});
