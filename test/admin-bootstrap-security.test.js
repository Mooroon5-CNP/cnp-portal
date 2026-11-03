'use strict';

const bcrypt = require('bcryptjs');
const db = require('../src/models/db');
test('fresh databases accept the explicit bootstrap password and never admin/admin', () => {
  const admin = db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get();
  expect(bcrypt.compareSync('admin', admin.password_hash)).toBe(false);
  expect(bcrypt.compareSync(process.env.ADMIN_INITIAL_PASSWORD, admin.password_hash)).toBe(true);
});
