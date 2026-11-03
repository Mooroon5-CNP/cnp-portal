'use strict';

const { createHmac, randomUUID } = require('crypto');

// Only the local launcher passes this secret in memory. Shared deployments use an issuer.
function createLocalToken(secret) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('MCP_LOCAL_SECRET_INVALID');
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'HS256' })}.${encode({
    iss: 'cnp-portal', aud: 'cnp-mcp', sub: 'local-operator', login: 'local-operator',
    scopes: ['cnp:read'], jti: randomUUID(), iat: issuedAt, exp: issuedAt + 300,
  })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

module.exports = { createLocalToken };
