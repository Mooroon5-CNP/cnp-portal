'use strict';

const { createHmac, randomUUID } = require('crypto');

/**
 * Short-lived HS256 JWT for the MCP server (iss cnp-portal, aud cnp-mcp, 5 minutes, scope cnp:read).
 * `claims` carries the portal user and, only after the portal authorized it, the role and target
 * (`app`, `env`) that the MCP enforces for Gemini Cloud Assist. The secret never leaves the process.
 */
function createLocalToken(secret, claims = {}) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('MCP_LOCAL_SECRET_INVALID');
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const { sub = 'local-operator', role, app, env } = claims;
  const unsigned = `${encode({ alg: 'HS256' })}.${encode({
    iss: 'cnp-portal', aud: 'cnp-mcp', sub: String(sub), login: String(sub),
    ...(role ? { role } : {}), ...(app ? { app } : {}), ...(env ? { env } : {}),
    scopes: ['cnp:read'], jti: randomUUID(), iat: issuedAt, exp: issuedAt + 300,
  })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

module.exports = { createLocalToken };
