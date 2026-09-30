'use strict';

const { createMcpClient } = require('./mcp-client');
const { createChatService } = require('./chat/service');
const { createRouter } = require('./http/router');
const { FixtureCatalog } = require('./catalog/fixture-catalog');
const { createKnownContextBuilder } = require('./context/known-context-builder');

function buildOrchestratorRouter({ requireAuth, mcpClient = createMcpClient(), catalog = new FixtureCatalog() }) {
  const buildKnownContext = createKnownContextBuilder(catalog);
  return createRouter({
    requireAuth,
    catalog,
    chatService: createChatService(mcpClient, buildKnownContext),
  });
}

module.exports = { buildOrchestratorRouter };
