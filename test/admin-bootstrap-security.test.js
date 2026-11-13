'use strict';

const bcrypt = require('bcryptjs');
const db = require('../src/models/db');
test('fresh databases accept the explicit bootstrap password and never admin/admin', () => {
  const admin = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
  expect(bcrypt.compareSync('admin', admin.password_hash)).toBe(false);
  expect(bcrypt.compareSync(process.env.ADMIN_INITIAL_PASSWORD, admin.password_hash)).toBe(true);
});

test('a fresh deployment starts without manual credentials and preserves the generated admin across restarts', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cnp-bootstrap-'));
  const previousPath = process.env.DB_PATH;
  const previousPassword = process.env.ADMIN_INITIAL_PASSWORD;
  process.env.DB_PATH = path.join(dir, 'portal.sqlite');
  delete process.env.ADMIN_INITIAL_PASSWORD;
  const run = () => jest.isolateModules(() => {
    const instance = require('../src/models/db');
    const password = fs.readFileSync(path.join(dir, 'admin-initial-password'), 'utf8').trim();
    const user = instance.prepare("SELECT password_hash FROM users WHERE username='admin'").get();
    expect(password).toMatch(/^[a-f0-9]{64}$/);
    expect(bcrypt.compareSync(password, user.password_hash)).toBe(true);
    expect(bcrypt.compareSync('admin', user.password_hash)).toBe(false);
    instance.close();
  });
  try {
    run();
    const first = fs.readFileSync(path.join(dir, 'admin-initial-password'), 'utf8');
    run();
    expect(fs.readFileSync(path.join(dir, 'admin-initial-password'), 'utf8')).toBe(first);
    expect(fs.statSync(path.join(dir, 'admin-initial-password')).mode & 0o777).toBe(0o600);
  } finally {
    process.env.DB_PATH = previousPath;
    process.env.ADMIN_INITIAL_PASSWORD = previousPassword;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
