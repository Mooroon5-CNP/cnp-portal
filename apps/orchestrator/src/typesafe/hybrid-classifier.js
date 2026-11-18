'use strict';

const { classifyWithFallback } = require('./fallback-classifier');
const { decideWithMistral } = require('./mistral-classifier');

function createHybridClassifier({ env = process.env, decide } = {}) {
  return async (input) => {
    const local = classifyWithFallback(input);
    // Explicit mutations never reach the model or a platform-changing tool.
    if (local.kind === 'mutation') return local;
    if (env.MCP_ROUTING_MODE === 'local' || (env.MCP_ROUTING_MODE !== 'mistral' && local.kind === 'tool')) return local;
    const target = input.knownContext.target;
    const environment = { development: 'dev', production: 'prod' }[target.environment];
    const minimal = { userRequest: input.userRequest,
      availableReadOnlyTools: input.knownContext.permissions.allowedTools,
      knownContext: { ...(target.applicationId ? { applicationId: target.applicationId } : {}),
        ...(environment ? { environment } : {}) } };
    try {
      const decision = await (decide ? decide(minimal) : decideWithMistral(minimal, { env }));
      if (decision.kind === 'route' && minimal.availableReadOnlyTools.includes(decision.tool)) return { kind: 'tool', tool: decision.tool, fallback: false, routedBy: 'mistral' };
      if (decision.kind === 'routing_unavailable') return { kind: 'routing_unavailable', reason: decision.reason };
      if (decision.kind === 'rejected') return { kind: decision.reason === 'mutation' ? 'mutation' : 'rejected' };
      return { kind: 'clarification' };
    } catch { return { kind: 'routing_unavailable', reason: 'configuration' }; }
  };
}

module.exports = { createHybridClassifier };
