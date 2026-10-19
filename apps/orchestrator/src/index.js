'use strict';

const { createMcpClient } = require('./mcp-client');
const { createChatService } = require('./chat/service');
const { createRouter } = require('./http/router');
const { FixtureCatalog } = require('./catalog/fixture-catalog');
const { McpCatalog } = require('./catalog/mcp-catalog');
const { createKnownContextBuilder } = require('./context/known-context-builder');

function buildOrchestratorRouter({ requireAuth, mcpClient = createMcpClient(), catalog = process.env.MCP_CLIENT_MODE === 'http' ? new McpCatalog(mcpClient) : new FixtureCatalog() }) {
  let runtimeForUser;
  if (process.env.MCP_DATA_MODE === 'real') {
    const { createUserScope } = require('./sources/user-scope');
    runtimeForUser = createUserScope(mcpClient, catalog);
  }
  const buildKnownContext = createKnownContextBuilder(catalog);
  return createRouter({
    requireAuth,
    runtimeForUser,
    catalog,
    chatService: createChatService(mcpClient, buildKnownContext),
  });
}

module.exports = { buildOrchestratorRouter };
