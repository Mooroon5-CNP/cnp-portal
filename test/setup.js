'use strict';

// Use an in-memory SQLite database for tests so runs are isolated
// and never pollute or depend on the on-disk data file.
process.env.DB_PATH = ':memory:';

process.env.ADMIN_INITIAL_PASSWORD = 'test-only-admin-password';
