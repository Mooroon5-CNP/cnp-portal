'use strict';

// Client for the CNP AI client / MCP orchestrator (CNP-047).
//
// Wire contract (portal → AI client):
//   POST ${AI_CLIENT_URL}
//   Authorization: Bearer <internal token, 5 min, aud=cnp-mcp>
//   X-Correlation-Id: <uuid>
//   Accept: text/event-stream
//   { conversationId, correlationId, userRequest, knownContext }
// Response: SSE stream of ChatEvents (`event: <type>` + `data: <json>`):
//   tool_status, answer_delta, source, warning, structured,
//   clarification_required, rejected, completed, error.
//
// AI_CLIENT_MODE=stub replaces the remote call with a local simulator so the
// chat can be developed and tested before CNP-047 is deployed. The stub does
// not call any platform source.

class AiClientError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail; // logged server-side only, never sent to the browser
  }
}

function parseSseBlock(block) {
  let type = 'message';
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  try {
    return { type, data: JSON.parse(data.join('\n')) };
  } catch (_) {
    return null;
  }
}

async function streamRemote({ url, token, payload, signal, onEvent }) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'X-Correlation-Id': payload.correlationId,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (e) {
    if (signal && signal.aborted) throw new AiClientError('TIMEOUT', e.message);
    throw new AiClientError('AI_CLIENT_UNAVAILABLE', e.message);
  }

  if (res.status === 401) throw new AiClientError('UNAUTHENTICATED', `HTTP ${res.status}`);
  if (res.status === 403) throw new AiClientError('FORBIDDEN', `HTTP ${res.status}`);
  if (res.status === 429) throw new AiClientError('RATE_LIMITED', `HTTP ${res.status}`);
  if (res.status === 504) throw new AiClientError('TIMEOUT', `HTTP ${res.status}`);
  if (!res.ok || !res.body) throw new AiClientError('AI_CLIENT_UNAVAILABLE', `HTTP ${res.status}`);

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
        const event = parseSseBlock(block);
        if (event) onEvent(event);
      }
    }
  } catch (e) {
    if (signal && signal.aborted) throw new AiClientError('TIMEOUT', e.message);
    throw new AiClientError('AI_CLIENT_UNAVAILABLE', e.message);
  }
}

// ---------------------------------------------------------------------------
// Local simulator (AI_CLIENT_MODE=stub)
// ---------------------------------------------------------------------------

const MUTATION = /\b(d[ée]ploie|d[ée]ployer|d[ée]ployez|deploy|red[ée]marre[rz]?|restart|supprime[rz]?|delete|scale|resize|redimensionne[rz]?|migre[rz]?|migrate|synchronise[rz]?|sync|rollback|promouvoir|promote|modifie[rz]?)\b/i;

function stubScenario(text, ctx) {
  const t = text.toLowerCase();
  const app = ctx.applicationId;
  const env = ctx.environment || 'dev';
  const now = new Date().toISOString();
  const say = s => s.split(/(?<= )/).map(chunk => ({ type: 'answer_delta', data: { text: chunk } }));
  const needApp = () => [
    { type: 'clarification_required', data: { question: 'Pour quelle application et quel environnement (dev ou prod) ?', options: [] } },
    { type: 'completed', data: { status: 'success' } },
  ];

  if (MUTATION.test(t)) {
    return [{ type: 'rejected', data: {} }, { type: 'completed', data: { status: 'success' } }];
  }
  if (/applications?|apps\b|liste/.test(t) && !/log|finops|co[uû]t/.test(t)) {
    return [
      { type: 'tool_status', data: { tool: 'list_applications', state: 'running' } },
      { type: 'source', data: { source: 'platform_api', status: 'available', retrievedAt: now } },
      { type: 'tool_status', data: { tool: 'list_applications', state: 'completed' } },
      { type: 'structured', data: { kind: 'application_list', data: { applications: [
        { applicationId: 'cnp-test-node', name: 'cnp-test-node', team: 'platform', environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: true }] },
      ], nextCursor: null } } },
      ...say('Voici les applications enregistrées visibles pour vous (données simulées).'),
      { type: 'completed', data: { status: 'success' } },
    ];
  }
  if (/log|erreur|error/.test(t)) {
    if (!app) return needApp();
    return [
      { type: 'tool_status', data: { tool: 'get_application_logs', state: 'running' } },
      { type: 'source', data: { source: 'datadog', status: 'available', retrievedAt: now } },
      { type: 'tool_status', data: { tool: 'get_application_logs', state: 'completed' } },
      { type: 'structured', data: { kind: 'application_logs', data: { logs: [
        { timestamp: now, level: 'ERROR', message: 'upstream timeout after 5000ms', service: app, version: 'abc123', correlationId: null },
        { timestamp: now, level: 'INFO', message: 'http request', service: app, version: 'abc123', correlationId: null },
      ], truncated: false, redactedFields: 1 } } },
      ...say(`Sur ${app} (${env}), la dernière erreur est un timeout d'un service amont (données simulées).`),
      { type: 'completed', data: { status: 'success' } },
    ];
  }
  if (/finops|co[uû]t|cost|optimi|ressource/.test(t)) {
    if (!app) return needApp();
    return [
      { type: 'tool_status', data: { tool: 'get_finops_recommendation', state: 'running' } },
      { type: 'source', data: { source: 'datadog_metrics', status: 'available', retrievedAt: now } },
      { type: 'source', data: { source: 'cloud_billing', status: 'not_configured' } },
      { type: 'warning', data: { code: 'FINOPS_COST_DATA_UNAVAILABLE', source: 'cloud_billing' } },
      { type: 'tool_status', data: { tool: 'get_finops_recommendation', state: 'completed' } },
      { type: 'structured', data: { kind: 'finops_recommendation', data: {
        recommendation: 'RESIZE_RESOURCES',
        utilization: { averageCpuPercent: 8, peakCpuPercent: 22, averageMemoryPercent: 41, peakMemoryPercent: 55 },
        currentMonthlyCost: null, estimatedTargetCost: null, estimatedMonthlySavings: null, currency: null,
        confidence: 'medium',
        assumptions: ['Observation sur 14 jours.'],
        risks: ['Pics de charge non observés.'],
        prerequisites: ['Valider avec l\'équipe propriétaire.'],
        nextSteps: ['Réduire la requête CPU à 50m.'],
      } } },
      ...say(`Pour ${app} (${env}), le CPU est très peu utilisé : un redimensionnement des ressources est recommandé (données simulées).`),
      { type: 'completed', data: { status: 'partial' } },
    ];
  }
  if (/d[ée]ploi|deploy|statut|status|version|sant[ée]|health/.test(t)) {
    if (!app) return needApp();
    return [
      { type: 'tool_status', data: { tool: 'get_deployment_status', state: 'running' } },
      { type: 'source', data: { source: 'git_config', status: 'available', retrievedAt: now } },
      { type: 'source', data: { source: 'argocd', status: 'unavailable' } },
      { type: 'warning', data: { code: 'SOURCE_UNAVAILABLE', source: 'argocd' } },
      { type: 'tool_status', data: { tool: 'get_deployment_status', state: 'completed' } },
      { type: 'structured', data: { kind: 'deployment_status', data: {
        applicationId: app, environment: env,
        desiredState: { version: 'abc123', imageDigest: null, sourceRevision: 'abc123' },
        observedState: { version: null, imageDigest: null, syncStatus: 'Unknown', healthStatus: 'Unknown' },
        driftDetected: null, lastDeploymentAt: null,
      } } },
      ...say(`La version attendue de ${app} en ${env} est abc123. Argo CD n'a pas répondu : l'état observé est inconnu (données simulées).`),
      { type: 'completed', data: { status: 'partial' } },
    ];
  }
  return [
    { type: 'clarification_required', data: {
      question: 'Je peux consulter les applications, l\'état des déploiements, les logs et les recommandations FinOps. Que souhaitez-vous consulter ?',
      options: ['Lister les applications', 'Statut du déploiement', 'Dernières erreurs dans les logs', 'Recommandation FinOps'],
    } },
    { type: 'completed', data: { status: 'success' } },
  ];
}

async function streamStub({ payload, signal, onEvent, delayMs }) {
  for (const event of stubScenario(payload.userRequest, payload.knownContext)) {
    if (signal && signal.aborted) throw new AiClientError('TIMEOUT', 'aborted');
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    onEvent(event);
  }
}

/**
 * Streams one chat turn. Calls onEvent({ type, data }) for every ChatEvent
 * received and throws an AiClientError on transport failure.
 */
async function streamTurn({ token, payload, signal, onEvent }) {
  const mode = process.env.AI_CLIENT_MODE;
  if (mode === 'stub') {
    const delayMs = parseInt(process.env.AI_CLIENT_STUB_DELAY_MS || '150', 10);
    return streamStub({ payload, signal, onEvent, delayMs });
  }
  const url = process.env.AI_CLIENT_URL;
  if (!url) throw new AiClientError('AI_CLIENT_UNAVAILABLE', 'AI_CLIENT_URL is not configured');
  return streamRemote({ url, token, payload, signal, onEvent });
}

function needsToken() {
  return process.env.AI_CLIENT_MODE !== 'stub';
}

module.exports = { streamTurn, needsToken, AiClientError, parseSseBlock };
