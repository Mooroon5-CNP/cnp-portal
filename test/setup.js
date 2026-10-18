'use strict';

// Use an in-memory SQLite database for tests so runs are isolated
// and never pollute or depend on the on-disk data file.
process.env.DB_PATH = ':memory:';

// Deployment tokens are encrypted at rest; the model refuses to load without a secret.
process.env.DEPLOYMENTS_SECRET = process.env.DEPLOYMENTS_SECRET || 'test-only-deployments-secret';
