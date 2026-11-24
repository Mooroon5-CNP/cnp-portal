'use strict';

const { classifyWithFallback } = require('./fallback-classifier');
const { decideWithMistral } = require('./mistral-classifier');

// Routing modes (MCP_ROUTING_MODE):
//  - default / "mistral-first": Mistral understands the request; keywords only when Mistral is unavailable or unsure;
//  - "hybrid": keywords first, Mistral only when no single keyword family matches (previous default);
//  - "mistral": Mistral only; "local": keywords only.
// Explicit change requests never reach the model.
function createHybridClassifier({ env = process.env, decide } = {}) {
  return async (input) => {
    const local = classifyWithFallback(input);
    if (local.kind === 'mutation') return local;
    const mode = env.MCP_ROUTING_MODE || 'mistral-first';
    if (mode === 'local' || (mode === 'hybrid' && local.kind === 'tool')) return local;
    const target = input.knownContext.target;
    const environment = { development: 'dev', production: 'prod' }[target.environment];
    const minimal = { userRequest: input.userRequest,
      availableReadOnlyTools: input.knownContext.permissions.allowedTools,
      knownContext: { ...(target.applicationId ? { applicationId: target.applicationId } : {}),
        ...(environment ? { environment } : {}) } };
    let decision;
    try { decision = await (decide ? decide(minimal) : decideWithMistral(minimal, { env })); }
    catch { decision = { kind: 'routing_unavailable', reason: 'configuration' }; }
    if (decision.kind === 'route' && minimal.availableReadOnlyTools.includes(decision.tool)) return { kind: 'tool', tool: decision.tool, fallback: false, routedBy: 'mistral' };
    if (decision.kind === 'rejected') return { kind: decision.reason === 'mutation' ? 'mutation' : 'rejected' };
    // Mistral unavailable or unsure: in mistral-first mode a confident keyword route still answers.
    if (mode === 'mistral-first' && local.kind === 'tool') return { ...local, routedBy: 'keywords' };
    if (decision.kind === 'routing_unavailable') return { kind: 'routing_unavailable', reason: decision.reason };
    return { kind: 'clarification' };
  };
}

module.exports = { createHybridClassifier };
