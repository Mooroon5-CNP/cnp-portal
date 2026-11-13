'use strict';

const { randomBytes } = require('crypto');
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification must remain enabled.');
const raw = process.env.SESSION_SECRET;
const configured = ['dev-secret-change-in-prod', 'dev-fallback-key-change-in-prod', 'change-me-in-production'].includes(raw) ? undefined : raw;
// An optional configured key survives restarts. Otherwise generate a private key
// once per process so deploying the application requires no manual secret setup.
const sessionSecret = (configured && Buffer.byteLength(configured) >= 32 ? configured : undefined) || randomBytes(32).toString('hex');
module.exports = { sessionSecret };
