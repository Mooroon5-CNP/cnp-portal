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
  if (localDecision.kind === 'mutation') {
    yield event({ type: 'error', correlationId, code: 'FORBIDDEN', retryable: false,
      message: 'Le chat MCP est strictement en lecture seule et ne peut pas effectuer cette action.' });
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
      message: 'La demande est incertaine et Jev ne répond pas. Choisissez une commande / ou réessayez.' });
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
