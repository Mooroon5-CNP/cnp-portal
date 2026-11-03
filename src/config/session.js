'use strict';

const { randomBytes } = require('crypto');
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled.');
const raw = process.env.SESSION_SECRET;
const configured = ['dev-secret-change-in-prod', 'dev-fallback-key-change-in-prod', 'change-me-in-production'].includes(raw) ? undefined : raw;
if (process.env.NODE_ENV === 'production' && (!configured || Buffer.byteLength(configured) < 32
  || ['dev-secret-change-in-prod', 'dev-fallback-key-change-in-prod'].includes(configured))) {
  throw new Error('Configure a random SESSION_SECRET of at least 32 bytes.');
}
// Missing local configuration invalidates sessions on restart, rather than using a public key.
const sessionSecret = configured || randomBytes(32).toString('hex');
module.exports = { sessionSecret };
