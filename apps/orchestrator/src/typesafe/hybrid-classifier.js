'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { classifyWithFallback } = require('./fallback-classifier');

function createHybridClassifier({ env = process.env, decide } = {}) {
  let router;
  return async (input) => {
    const local = classifyWithFallback(input);
    // Explicit mutations never reach Jev or a platform-changing tool.
    if (local.kind === 'mutation') return local;
    if (env.MCP_ROUTING_MODE === 'local' || (env.MCP_ROUTING_MODE !== 'jev' && local.kind === 'tool')) return local;
    const target = input.knownContext.target;
    const environment = { development: 'dev', production: 'prod' }[target.environment];
    const minimal = { userRequest: input.userRequest,
      availableReadOnlyTools: input.knownContext.permissions.allowedTools,
      knownContext: { ...(target.applicationId ? { applicationId: target.applicationId } : {}),
        ...(environment ? { environment } : {}) } };
    try {
      if (!decide && !router) {
        const root = path.resolve(env.MCP_PROJECT_DIR || path.join(__dirname, '../../../../../MCP-CNP'));
        const module = await import(pathToFileURL(path.join(root, 'dist/apps/orchestrator/src/typesafe.js')).href);
        router = module.createTypeSafeRouter({ env });
      }
      const decision = await (decide ? decide(minimal) : router.decide(minimal));
      if (decision.kind === 'route') return { kind: 'tool', tool: decision.tool, fallback: false, routedBy: 'jev' };
      if (decision.kind === 'routing_unavailable') return { kind: 'routing_unavailable', reason: decision.reason };
      if (decision.kind === 'rejected') return { kind: decision.reason === 'mutation' ? 'mutation' : 'rejected' };
      return { kind: 'clarification' };
    } catch { return { kind: 'routing_unavailable', reason: 'configuration' }; }
  };
}

module.exports = { createHybridClassifier };
