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

function createMcpClient(env = process.env) {
  if (env.MCP_CLIENT_MODE === 'http') {
    const { HttpMcpClient } = require('./http-client');
    let tokenProvider;
    if (env.MCP_LOCAL_JWT_SECRET) {
      const url = new URL(env.MCP_URL || env.MCP_BASE_URL);
      if (env.NODE_ENV === 'production' || process.env.NODE_ENV === 'production'
        || env.MCP_LOCAL_HTTP !== 'true' || url.hostname !== '127.0.0.1' || url.protocol !== 'http:') {
        throw new Error('Local JWT signing requires development and loopback HTTP');
      }
      const { createLocalToken } = require('./local-token');
      createLocalToken(env.MCP_LOCAL_JWT_SECRET);
      tokenProvider = () => createLocalToken(env.MCP_LOCAL_JWT_SECRET);
    }
    return new HttpMcpClient({
      url: env.MCP_URL || env.MCP_BASE_URL,
      token: env.MCP_TOKEN,
      tokenProvider,
      origin: env.MCP_ORIGIN || env.MCP_EXPECTED_ORIGIN,
      local: env.MCP_LOCAL_HTTP === 'true',
      timeoutMs: Number(env.MCP_TOOL_TIMEOUT_MS || 10000),
    });
  }
  if (env.MCP_CLIENT_MODE && env.MCP_CLIENT_MODE !== 'fake') throw new Error('INVALID_MCP_CLIENT_MODE');
  if (env.MCP_URL || env.MCP_BASE_URL) throw new Error('Set MCP_CLIENT_MODE=http to connect an MCP endpoint');
  return new FakeMcpClient();
}

module.exports = { assertSecureMcpUrl, createMcpClient };
