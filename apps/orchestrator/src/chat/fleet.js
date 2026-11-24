'use strict';

// "Fleet" questions: logs or deployment status for every application the user can see, instead of asking which one.
// Built only from the existing read-only MCP tools (list_applications, get_application_logs, get_deployment_status),
// each call going through the user-scoped client: a user only sees their own applications.

const MAX_TARGETS = 12;
const CONCURRENCY = 4;
const LOG_WINDOW_MS = 60 * 60 * 1000;

const normalize = text => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
const ALL_WORDS = /\b(toutes?|tous|all|chaque|ensemble|flotte|global(?:e|ement)?|partout|plateforme|every)\b/i;
const PROBLEM_WORDS = /(non[\s-]?sync|pas\s+(?:sync|synchronis)|desynchronis|out[\s-]*of[\s-]*sync|unsync|en\s+(?:erreur|panne|echec)|degrad|unhealthy|pas\s+(?:en\s+)?(?:bonne\s+)?sante|probleme|cass(?:e|ee|ees)|ko\b|down\b)/i;

const TARGET_ENV = { development: 'dev', production: 'prod', dev: 'dev', prod: 'prod' };

/**
 * Decides whether a turn is a fleet question. `argsMissing` means the single-application path would have to ask the
 * user which application or environment. Returns null for a normal single-application turn.
 */
function fleetPlan({ tool, message, target = {}, argsMissing }) {
  const text = normalize(message);
  const problems = PROBLEM_WORDS.test(text);
  const everyone = ALL_WORDS.test(text);
  if (tool === 'list_applications') return problems ? { tool: 'get_deployment_status', onlyProblems: true, scope: {} } : null;
  if (!['get_application_logs', 'get_deployment_status'].includes(tool)) return null;
  if (!argsMissing && !everyone) return null;
  // "toutes les apps" ignores the page's application; otherwise keep what is known (one app, or one environment).
  const scope = everyone ? {} : { applicationId: target.applicationId, environment: TARGET_ENV[target.environment] };
  return { tool, onlyProblems: tool === 'get_deployment_status' && problems, scope };
}

async function mapLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => { while (next < items.length) { const index = next++; results[index] = await worker(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const short = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 140);

function logsSummary(rows, failures, truncated) {
  const withLogs = rows.filter(row => row.result.data.logs.length);
  const lines = [];
  if (!withLogs.length) {
    lines.push(`Aucune erreur ni avertissement sur la dernière heure pour les ${rows.length} environnement(s) consulté(s).`);
  } else {
    lines.push(`Erreurs et avertissements de la dernière heure (${withLogs.length} environnement(s) concerné(s) sur ${rows.length}) :`);
    for (const row of withLogs.sort((a, b) => b.errors - a.errors || b.warnings - a.warnings)) {
      const latest = row.result.data.logs[0];
      lines.push(`- ${row.applicationId}/${row.environment} : ${row.errors} erreur(s), ${row.warnings} avertissement(s)`
        + (latest ? ` — dernier : « ${short(latest.message)} »` : ''));
    }
  }
  return finish(lines, failures, truncated);
}

function statusSummary(rows, failures, truncated, onlyProblems) {
  const problems = rows.filter(row => row.problem);
  const shown = onlyProblems ? problems : rows;
  const lines = [];
  if (onlyProblems && !problems.length) {
    lines.push(`Tout est synchronisé et en bonne santé (${rows.length} environnement(s) vérifié(s)).`);
  } else {
    lines.push(onlyProblems
      ? `${problems.length} environnement(s) désynchronisé(s) ou en mauvaise santé sur ${rows.length} :`
      : `État des déploiements (${rows.length} environnement(s), ${problems.length} à surveiller) :`);
    for (const row of shown) {
      const observed = row.result.data.observedState || {};
      const version = observed.version ? `, version ${String(observed.version).slice(0, 7)}` : '';
      lines.push(`- ${row.problem ? '⚠️ ' : ''}${row.applicationId}/${row.environment} : ${observed.syncStatus || 'Unknown'}/${observed.healthStatus || 'Unknown'}${version}${row.result.data.driftDetected ? ', dérive détectée' : ''}`);
    }
  }
  return finish(lines, failures, truncated);
}

function finish(lines, failures, truncated) {
  if (failures.length) lines.push(`Sources indisponibles pour : ${failures.map(item => `${item.applicationId}/${item.environment}`).join(', ')}.`);
  if (truncated) lines.push(`Seuls les ${MAX_TARGETS} premiers environnements ont été consultés ; précisez une application pour le reste.`);
  return lines.join('\n');
}

/**
 * Runs a fleet turn. `deps` provides mcpClient, inputSchemas, responseSchemas, now and generateAnswer; `emit` validates
 * and returns a chat event (the caller yields it).
 */
async function* runFleetTurn({ message, plan, correlationId }, deps, emit) {
  const listArgs = deps.inputSchemas.list_applications.parse({ limit: 100, ...(plan.scope.environment ? { environment: plan.scope.environment } : {}) });
  yield emit({ type: 'tool_started', correlationId, tool: 'list_applications' });
  const listed = deps.responseSchemas.list_applications.parse(await deps.mcpClient.callTool('list_applications', listArgs, { correlationId }));
  yield emit({ type: 'tool_completed', correlationId, tool: 'list_applications', status: listed.status });
  if (listed.status === 'error') {
    yield emit({ type: 'error', correlationId, code: listed.errors[0]?.code || 'SOURCE_UNAVAILABLE', retryable: true,
      message: 'La liste des applications est indisponible ; réessayez dans un instant.' });
    return;
  }
  const targets = listed.data.applications
    .filter(app => !plan.scope.applicationId || app.applicationId === plan.scope.applicationId)
    .flatMap(app => app.environments.filter(env => env.enabled && (!plan.scope.environment || env.name === plan.scope.environment))
      .map(env => ({ applicationId: app.applicationId, environment: env.name })));
  if (!targets.length) {
    yield emit({ type: 'answer_delta', correlationId, text: 'Aucune application accessible ne correspond à cette demande.' });
    yield emit({ type: 'turn_completed', correlationId, sources: [] });
    return;
  }
  const truncated = targets.length > MAX_TARGETS;
  const selected = targets.slice(0, MAX_TARGETS);
  const now = deps.now();
  yield emit({ type: 'tool_started', correlationId, tool: plan.tool });
  const outcomes = await mapLimited(selected, CONCURRENCY, async (target) => {
    const args = plan.tool === 'get_application_logs'
      ? { ...target, from: new Date(now.getTime() - LOG_WINDOW_MS).toISOString(), to: now.toISOString(), levels: ['ERROR', 'WARN'], limit: 20 }
      : target;
    try {
      const result = deps.responseSchemas[plan.tool].parse(await deps.mcpClient.callTool(plan.tool, deps.inputSchemas[plan.tool].parse(args), { correlationId }));
      return result.status === 'error' ? { ...target, failed: true } : { ...target, result };
    } catch { return { ...target, failed: true }; }
  });
  const rows = outcomes.filter(item => !item.failed).map(row => {
    if (plan.tool === 'get_application_logs') {
      const logs = row.result.data.logs;
      return { ...row, errors: logs.filter(log => log.level === 'ERROR').length, warnings: logs.filter(log => log.level === 'WARN').length };
    }
    const observed = row.result.data.observedState || {};
    return { ...row, problem: observed.syncStatus !== 'Synced' || observed.healthStatus !== 'Healthy' || row.result.data.driftDetected === true };
  });
  const failures = outcomes.filter(item => item.failed);
  yield emit({ type: 'tool_completed', correlationId, tool: plan.tool,
    status: !rows.length ? 'error' : failures.length || rows.some(row => row.result.status === 'partial') ? 'partial' : 'success' });
  const shown = plan.tool === 'get_application_logs' ? rows.filter(row => row.result.data.logs.length)
    : plan.onlyProblems ? rows.filter(row => row.problem) : rows;
  for (const row of shown) {
    yield emit({ type: 'tool_result', correlationId, status: row.result.status, result: { tool: plan.tool, data: row.result.data } });
  }
  let answer = plan.tool === 'get_application_logs' ? logsSummary(rows, failures, truncated)
    : statusSummary(rows, failures, truncated, plan.onlyProblems);
  if (deps.generateAnswer && rows.length) {
    const evidence = { status: failures.length ? 'partial' : 'success', warnings: [],
      data: { scope: 'all accessible applications', summary: answer },
      meta: { sources: [...new Map(rows.flatMap(row => row.result.meta.sources).map(s => [s.source, s])).values()] } };
    try { answer = await deps.generateAnswer({ message, tool: plan.tool, result: evidence }); } catch { /* deterministic summary kept */ }
  }
  yield emit({ type: 'answer_delta', correlationId, text: answer });
  const sources = new Map();
  for (const row of rows) for (const { source, status } of row.result.meta.sources) sources.set(source, { source, status });
  yield emit({ type: 'turn_completed', correlationId, sources: [...sources.values()] });
}

// True when the request is about every application or about problems: the turn must not ask "which application?".
function mentionsFleet(message) {
  const text = normalize(message);
  return ALL_WORDS.test(text) || PROBLEM_WORDS.test(text);
}

module.exports = { fleetPlan, runFleetTurn, mentionsFleet, MAX_TARGETS };
