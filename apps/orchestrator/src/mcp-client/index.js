'use strict';

const { FakeMcpClient } = require('./fake-client');

function assertSecureMcpUrl(baseUrl, nodeEnv = process.env.NODE_ENV) {
  if (!baseUrl) return;
  const parsed = new URL(baseUrl);
  const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  if (parsed.protocol !== 'https:' && !(local && nodeEnv !== 'production')) {
    const error = new Error('Remote MCP endpoints must use HTTPS');
    error.code = 'TLS_REQUIRED';
    throw error;
  }
}

function createMcpClient() {
  assertSecureMcpUrl(process.env.MCP_BASE_URL);
  // The transport boundary is injectable. The contract fake keeps this first
  // increment executable until the Streamable HTTP client is introduced.
  return new FakeMcpClient();
}

module.exports = { assertSecureMcpUrl, createMcpClient };
