'use strict';

const { createMcpClient } = require('./mcp-client');
const { createChatService } = require('./chat/service');
const { createRouter } = require('./http/router');
const { FixtureCatalog } = require('./catalog/fixture-catalog');
const { McpCatalog } = require('./catalog/mcp-catalog');
const { createKnownContextBuilder } = require('./context/known-context-builder');
const { createApplicationResolver } = require('./generation/application');

function dataMode(env = process.env) {
  if (env.MCP_DATA_MODE === 'mock') return 'mock';
  return env.MCP_CLIENT_MODE === 'http' || env.MCP_DATA_MODE === 'real' ? 'real' : 'mock';
}

function buildOrchestratorRouter({ requireAuth, mcpClient = createMcpClient(), catalog = process.env.MCP_CLIENT_MODE === 'http' ? new McpCatalog(mcpClient) : new FixtureCatalog(), deployments }) {
  let runtimeForUser;
  const contextOptions = { resolveApplication: createApplicationResolver() };
  const mode = dataMode();
  if (mode === 'real') {
    const { createUserScope } = require('./sources/user-scope');
    runtimeForUser = createUserScope(mcpClient, catalog, deployments, contextOptions);
  }
  const buildKnownContext = createKnownContextBuilder(catalog, contextOptions);
  return createRouter({
    requireAuth,
    dataMode: mode,
    runtimeForUser,
    catalog,
    chatService: createChatService(mcpClient, buildKnownContext),
  });
}

module.exports = { buildOrchestratorRouter, dataMode };
