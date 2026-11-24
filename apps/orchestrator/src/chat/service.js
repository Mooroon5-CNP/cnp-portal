'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  chatTurnRequestSchema, chatEventSchema, inputSchemas, responseSchemas, toolNames,
} = require('../../../../packages/contracts/src');
const { classifyWithFallback } = require('../typesafe/fallback-classifier');
const { createHybridClassifier } = require('../typesafe/hybrid-classifier');
const { createAnswerGenerator } = require('../generation/answer');
const { commands, resolveCommand } = require('../commands');
const { buildToolArguments } = require('../orchestration/arguments');
const { AmbiguousContextError } = require('../context/known-context-builder');
const { buildTransverseAnswer, collectSources, assertCitedSources } = require('../generation/diagnostic');
const { fleetPlan, runFleetTurn, mentionsFleet } = require('./fleet');

const GREETING = /^\s*(bonjour|bonsoir|salut|coucou|hello|hi|hey|aide|help|merci|que\s+(?:peux|sais)[\s-]+tu\s+faire|qu'?est[\s-]+ce\s+que\s+tu\s+(?:peux|sais)\s+faire)\b[\s!?.,]*/i;
const WELCOME = 'Bonjour ! Je consulte vos applications CNP en lecture seule. Par exemple :\n'
  + '- « Quelles applications sont désynchronisées ? »\n'
  + '- « Montre les erreurs de la dernière heure sur toutes les apps »\n'
  + '- « Comment va <application> en prod ? »\n'
  + '- « Combien coûte <application> ? »\n'
  + 'Tapez / pour la liste des commandes.';

function event(value) {
  return chatEventSchema.parse(value);
}

function answerFor(tool, result) {
  if (tool === 'list_applications') {
    const names = result.data.applications.map((application) => application.name).join(', ');
    return names ? `Applications enregistrées : ${names}.` : 'Aucune application ne correspond à la recherche.';
  }
  if (tool === 'get_deployment_status') {
    const state = result.data.observedState;
    const desired = result.data.desiredState.version || 'non disponible';
    const observed = state.healthStatus === 'Unknown' && state.syncStatus === 'Unknown'
      ? 'état observé indisponible' : `${state.healthStatus} / ${state.syncStatus}`;
    return `${result.data.applicationId} (${result.data.environment}) : ${observed}. Version souhaitée : ${desired}.`;
  }
  if (tool === 'get_application_logs') {
    return `${result.data.logs.length} entrée(s) de log trouvée(s) dans la dernière heure.`;
  }
  return `Recommandation : ${result.data.recommendation}. Les montants financiers restent indisponibles.`;
}

const GCP_PATTERN = /\b(gcp|google cloud|gemini cloud assist|cloud assist)\b/i;
/** Explicit command, or explicit Google Cloud vocabulary; generic words keep their existing CNP routing. */
function gcaIntent(message, command) {
  if (command && command.capability) return { capability: command.capability, transverse: command.transverse };
  // Any other explicit slash command (/logs, /deploiement, /applications, /finops) keeps its own tool.
  if (command) return undefined;
  const text = message.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  if (!GCP_PATTERN.test(text)) return undefined;
  if (/\b(investig\w*|incident|panne|cause|diagnost\w*|pourquoi|erreurs?|errors?|lent|latence)\b/i.test(text)) return { capability: 'investigate_issue', transverse: false };
  if (/\b(couts?|factur\w*|billing|depenses?|idle|inutilis\w*|economi\w*)\b/i.test(text)) return { capability: 'optimize_costs', transverse: false };
  return { capability: 'ask_cloud_assist', transverse: false };
}

const gcaMessages = {
  FORBIDDEN: 'Application ou environnement non autorisé pour cette analyse Google Cloud.',
  TOOL_UNAVAILABLE: 'Gemini Cloud Assist n’est pas activé sur le serveur MCP (GCA_ENABLED).',
  GCA_PERMISSION_DENIED: 'Gemini Cloud Assist refuse l’accès : accès Private Preview ou rôles IAM de l’identité de service manquants.',
  GCA_DISABLED: 'L’API Gemini Cloud Assist est désactivée sur le projet Google Cloud.',
  GCA_AUTH: 'Le serveur MCP n’a pas pu s’authentifier auprès de Google Cloud.',
  GCA_TIMEOUT: 'Gemini Cloud Assist n’a pas répondu dans le délai prévu.',
  GCA_RATE_LIMITED: 'Quota Gemini Cloud Assist atteint ; réessayez plus tard.',
};
const gcaFailure = (result) => result.errorCode || (result.errors && result.errors[0] && result.errors[0].code) || 'GCA_UNAVAILABLE';

const GCA_CONSOLE_URL = 'https://console.cloud.google.com/home/dashboard?project=cnp-terraform-512313';

/** Gemini Cloud Assist turn: read-only, structured, never rewritten by the generative model. */
async function* runGcaTurn(request, dependencies, { correlationId, conversationId, intent }) {
  const { actor } = dependencies;
  // Managers only: GCA analyses the whole Google Cloud project with a shared service identity.
  const roles = dependencies.gcaRoles || ['manager'];
  if (!actor || !actor.roles.some((role) => roles.includes(role))) {
    yield event({ type: 'error', correlationId, code: 'FORBIDDEN', retryable: false,
      message: 'Gemini Cloud Assist est indisponible pour votre rôle. Pour diagnostiquer une application, utilisez /deploiement et /logs.' });
    return;
  }
  // Until Google opens the Cloud Assist MCP Private Preview to the project, managers use it in the console.
  if (!dependencies.gcaChatEnabled) {
    yield event({ type: 'error', correlationId, code: 'GCA_NOT_ENABLED', retryable: false,
      message: 'Gemini Cloud Assist n’est pas encore disponible dans le chat : Google n’a pas encore ouvert l’accès (Private Preview). '
        + 'Utilisez-le dans la console Google Cloud, avec l’icône Gemini Cloud Assist en haut de la page.',
      link: { href: dependencies.gcaConsoleUrl || GCA_CONSOLE_URL, label: 'Ouvrir Gemini Cloud Assist dans la console Google Cloud' } });
    return;
  }
  if (dependencies.clearClarification) await dependencies.clearClarification({ conversationId });
  let knownContext;
  try {
    knownContext = await dependencies.buildKnownContext({
      actor, allowedTools: dependencies.allowedTools || toolNames, portalContext: request.context,
      pageContext: dependencies.pageContext, confirmedConversationContext: dependencies.confirmedConversationContext,
      userRequest: request.message, resolveApplication: intent.transverse,
    });
  } catch (error) {
    if (!(error instanceof AmbiguousContextError)) throw error;
    yield event({ type: 'clarification_required', correlationId,
      question: `Plusieurs applications correspondent (${error.candidates.join(', ')}). Précisez laquelle.` });
    return;
  }
  const environment = { development: 'dev', production: 'prod' }[knownContext.target.environment];
  const target = knownContext.target.applicationId && environment ? { applicationId: knownContext.target.applicationId, environment } : undefined;
  if (intent.transverse && !target) {
    yield event({ type: 'clarification_required', correlationId,
      question: 'Sélectionnez une application et un environnement (dev ou prod), puis relancez /diagnostic.' });
    return;
  }
  const calls = { gcp_cloud_assist: { capability: intent.capability, question: request.message, conversationId, ...(target || {}) } };
  if (intent.transverse) {
    calls.get_deployment_status = buildToolArguments('get_deployment_status', knownContext, dependencies.now());
    calls.get_application_logs = buildToolArguments('get_application_logs', knownContext, dependencies.now());
  }
  for (const tool of Object.keys(calls)) yield event({ type: 'tool_started', correlationId, tool });
  const results = Object.fromEntries(await Promise.all(Object.entries(calls).map(async ([tool, args]) => {
    try { return [tool, await dependencies.mcpClient.callTool(tool, args, { correlationId, actor })]; }
    catch (error) { return [tool, { errorCode: error.code || 'GCA_UNAVAILABLE' }]; }
  })));
  for (const [tool, result] of Object.entries(results)) {
    yield event({ type: 'tool_completed', correlationId, tool, status: result.errorCode ? 'error' : result.status });
    for (const warning of result.warnings || []) yield event({ type: 'warning', correlationId, code: warning.code, message: warning.message });
    if (tool !== 'gcp_cloud_assist' && !result.errorCode && result.status !== 'error') {
      yield event({ type: 'tool_result', correlationId, status: result.status, result: { tool, data: result.data } });
    }
  }
  const gca = results.gcp_cloud_assist;
  let answer, sources;
  if (intent.transverse) {
    const logs = calls.get_application_logs;
    answer = buildTransverseAnswer({ target, logWindow: { from: logs.from, to: logs.to }, results });
    sources = collectSources(results);
  } else if (gca.errorCode || gca.status === 'error') {
    const code = gcaFailure(gca);
    yield event({ type: 'error', correlationId, code, retryable: ['GCA_TIMEOUT', 'GCA_UNAVAILABLE', 'GCA_RATE_LIMITED', 'GCA_NETWORK'].includes(code),
      message: gcaMessages[code] || 'Gemini Cloud Assist est temporairement indisponible. Les autres fonctions du chat restent disponibles.' });
    return;
  } else {
    answer = gca.data.answer;
    sources = gca.meta.sources.map(({ source, status }) => ({ source, status }));
  }
  assertCitedSources(answer, sources);
  yield event({ type: 'diagnostic_answer', correlationId, answer, sources });
  yield event({ type: 'answer_delta', correlationId, text: answer.summary });
  yield event({ type: 'turn_completed', correlationId, sources });
}

async function* runChatTurn(rawRequest, dependencies) {
  const request = chatTurnRequestSchema.parse(rawRequest);
  const command = resolveCommand(request.message);
  const bareCommand = Boolean(command && request.message.trim().split(/\s+/).length === 1);
  if (command) request.message = command.message;
  const correlationId = uuidv4();
  const conversationId = request.conversationId || uuidv4();
  yield event({ type: 'turn_started', conversationId, correlationId });

  if (request.message === '/annuler') {
    if (dependencies.clearClarification) await dependencies.clearClarification({ conversationId });
    yield event({ type: 'answer_delta', correlationId, text: 'La demande en attente est annulée.' });
    yield event({ type: 'turn_completed', correlationId, sources: [] });
    return;
  }

  if (request.message === '/' || request.message === '/aide') {
    yield event({ type: 'answer_delta', correlationId, text: commands.map((item) => `${item.command} — ${item.description}`).join('\n') });
    yield event({ type: 'turn_completed', correlationId, sources: [] });
    return;
  }

  // An explicit command replaces the previous intent; free-text replies retain it.
  if (command && dependencies.clearClarification) await dependencies.clearClarification({ conversationId });
  const localDecision = classifyWithFallback(request.message);
  // Greetings and "what can you do" get a short answer with examples instead of a menu-like clarification.
  if (!command && GREETING.test(request.message) && localDecision.kind === 'clarification'
    && request.message.replace(GREETING, '').trim().length < 3) {
    yield event({ type: 'answer_delta', correlationId, text: WELCOME });
    yield event({ type: 'turn_completed', correlationId, sources: [] });
    return;
  }
  if (localDecision.kind === 'mutation') {
    yield event({ type: 'error', correlationId, code: 'FORBIDDEN', retryable: false,
      message: 'Le chat MCP est strictement en lecture seule et ne peut pas effectuer cette action.' });
    return;
  }
  const gcaRequest = gcaIntent(request.message, command);
  if (gcaRequest && bareCommand && !gcaRequest.transverse) {
    yield event({ type: 'clarification_required', correlationId, question: 'Posez votre question Google Cloud après /gcp, par exemple : /gcp quels services Cloud Run sont en erreur ?' });
    return;
  }
  if (gcaRequest) {
    yield* runGcaTurn(request, dependencies, { correlationId, conversationId, intent: gcaRequest });
    return;
  }
  const pending = !command && dependencies.pendingRequest;
  const pendingTool = pending && toolNames.includes(pending.tool) ? pending.tool : undefined;
  const intendedTool = command?.tool || pendingTool || (localDecision.kind === 'tool' ? localDecision.tool : undefined);
  const register = async (tool, target = {}) => {
    if (dependencies.registerClarification) await dependencies.registerClarification({
      conversationId, clarificationId: correlationId, tool, target,
    });
  };

  let knownContext;
  try {
    knownContext = await dependencies.buildKnownContext({
      actor: dependencies.actor,
      allowedTools: dependencies.allowedTools || toolNames,
      portalContext: request.context,
      pageContext: dependencies.pageContext,
      confirmedConversationContext: pending?.target || dependencies.confirmedConversationContext,
      pendingClarificationId: dependencies.pendingClarificationId,
      userRequest: request.message,
      resolveApplication: Boolean(intendedTool && intendedTool !== 'list_applications' && !bareCommand
        && !mentionsFleet(request.message)
        && !/^(?:en\s+)?(?:dev|development|prod|production|staging)$/i.test(request.message.trim())),
    });
  } catch (error) {
    if (!(error instanceof AmbiguousContextError)) throw error;
    await register(intendedTool, pending?.target);
    yield event({
      type: 'clarification_required', correlationId,
      question: `Plusieurs applications correspondent (${error.candidates.join(', ')}). Laquelle souhaitez-vous consulter ?`,
    });
    return;
  }

  const classification = intendedTool && (command || pendingTool) ? { kind: 'tool', tool: intendedTool } : await dependencies.classify({
    userRequest: request.message,
    availableReadOnlyTools: toolNames,
    knownContext,
  });
  if (classification.kind === 'routing_unavailable') {
    yield event({ type: 'error', correlationId, code: 'ROUTING_UNAVAILABLE', retryable: true,
      message: 'La demande est incertaine et Mistral ne répond pas. Choisissez une commande / ou réessayez.' });
    return;
  }
  if (classification.kind === 'rejected') {
    yield event({ type: 'error', correlationId, code: 'UNSUPPORTED_REQUEST', retryable: false,
      message: 'Cette demande ne correspond pas aux outils disponibles. Tapez / pour les consulter.' });
    return;
  }
  if (classification.kind === 'mutation') {
    yield event({
      type: 'error', correlationId, code: 'FORBIDDEN', retryable: false,
      message: 'Le chat MCP est strictement en lecture seule et ne peut pas effectuer cette action.',
    });
    return;
  }
  if (classification.kind !== 'tool') {
    await register(undefined, knownContext.target);
    yield event({
      type: 'clarification_required', correlationId,
      question: 'Souhaitez-vous consulter les applications, un déploiement, des logs ou une recommandation FinOps ?',
    });
    return;
  }

  const tool = classification.tool;
  if (!knownContext.permissions.allowedTools.includes(tool)) {
    yield event({ type: 'error', correlationId, code: 'FORBIDDEN', retryable: false,
      message: 'Cet outil n’est pas autorisé pour cette demande.' });
    return;
  }
  const args = buildToolArguments(tool, knownContext, dependencies.now());
  // No application given (or "toutes les apps", "non sync"): answer for every accessible application at once.
  const fleet = fleetPlan({ tool, message: request.message, target: knownContext.target, argsMissing: !args });
  if (fleet && knownContext.permissions.allowedTools.includes(fleet.tool)) {
    yield* runFleetTurn({ message: request.message, plan: fleet, correlationId },
      { mcpClient: dependencies.mcpClient, inputSchemas, responseSchemas, now: dependencies.now,
        generateAnswer: dependencies.generateAnswer }, event);
    if (dependencies.clearClarification) await dependencies.clearClarification({ conversationId });
    return;
  }
  if (!args) {
    await register(tool, knownContext.target);
    yield event({
      type: 'clarification_required', correlationId,
      question: !knownContext.target.applicationId
        ? (knownContext.target.environment ? 'Quelle application souhaitez-vous consulter ? Donnez son nom ou une description.'
          : 'Quelle application et quel environnement (dev ou prod) souhaitez-vous consulter ?')
        : `Quel environnement (dev ou prod) souhaitez-vous consulter pour ${knownContext.target.applicationId} ?`,
    });
    return;
  }

  const validatedArgs = inputSchemas[tool].parse(args);
  yield event({ type: 'tool_started', correlationId, tool });
  const rawResult = await dependencies.mcpClient.callTool(tool, validatedArgs, { correlationId });
  const result = responseSchemas[tool].parse(rawResult);
  yield event({ type: 'tool_completed', correlationId, tool, status: result.status });
  for (const warning of result.warnings) {
    yield event({ type: 'warning', correlationId, code: warning.code, message: warning.message });
  }
  if (result.status === 'error') {
    const issue = result.errors[0];
    yield event({ type: 'error', correlationId, code: issue.code, message: issue.code === 'OBSERVABILITY_NOT_CONFIGURED'
      ? 'Datadog n’est pas configuré : renseignez DD_API_KEY et DD_APP_KEY pour consulter les logs.' : issue.message, retryable: issue.retryable });
    return;
  }
  // Publish only validated, user-scoped evidence. Rendering never depends on an LLM.
  yield event({ type: 'tool_result', correlationId, status: result.status, result: { tool, data: result.data } });
  let answer = answerFor(tool, result);
  if (dependencies.generateAnswer) {
    try { answer = await dependencies.generateAnswer({ message: request.message, tool, result }); }
    catch { yield event({ type: 'warning', correlationId, code: 'GENERATION_UNAVAILABLE',
      message: 'La génération IA est indisponible ; les données vérifiées sont affichées directement.' }); }
  }
  yield event({ type: 'answer_delta', correlationId, text: answer });
  yield event({
    type: 'turn_completed', correlationId,
    sources: result.meta.sources.map(({ source, status }) => ({ source, status })),
  });
  if (dependencies.clearClarification) await dependencies.clearClarification({ conversationId });
  if (dependencies.confirmContext && Object.keys(knownContext.target).length) {
    await dependencies.confirmContext({ conversationId, knownContext: knownContext.target });
  }
}

function createChatService(mcpClient, buildKnownContext, options = {}) {
  const classify = options.classify || createHybridClassifier();
  const generateAnswer = options.generateAnswer || createAnswerGenerator();
  return {
    run: (request, runtime = {}) => runChatTurn(request, {
      mcpClient,
      classify,
      generateAnswer,
      buildKnownContext,
      now: () => new Date(),
      ...runtime,
    }),
  };
}

module.exports = { createChatService, runChatTurn };
