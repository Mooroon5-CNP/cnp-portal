'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  chatTurnRequestSchema, chatEventSchema, inputSchemas, responseSchemas, toolNames,
} = require('../../../../packages/contracts/src');
const { classifyWithFallback } = require('../typesafe/fallback-classifier');
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
    return `${result.data.applicationId} est ${state.healthStatus} et ${state.syncStatus} sur ${result.data.environment}.`;
  }
  if (tool === 'get_application_logs') {
    return `${result.data.logs.length} entrée(s) de log trouvée(s) dans la dernière heure.`;
  }
  return `Recommandation : ${result.data.recommendation}. Les montants financiers restent indisponibles.`;
}

async function* runChatTurn(rawRequest, dependencies) {
  const request = chatTurnRequestSchema.parse(rawRequest);
  const correlationId = uuidv4();
  const conversationId = request.conversationId || uuidv4();
  yield event({ type: 'turn_started', conversationId, correlationId });

  let knownContext;
  try {
    knownContext = await dependencies.buildKnownContext({
      actor: dependencies.actor,
      allowedTools: dependencies.allowedTools || toolNames,
      portalContext: request.context,
      pageContext: dependencies.pageContext,
      confirmedConversationContext: dependencies.confirmedConversationContext,
      pendingClarificationId: dependencies.pendingClarificationId,
      userRequest: request.message,
    });
  } catch (error) {
    if (!(error instanceof AmbiguousContextError)) throw error;
    if (dependencies.registerClarification) {
      await dependencies.registerClarification({ conversationId, clarificationId: correlationId });
    }
    yield event({
      type: 'clarification_required', correlationId,
      question: `Plusieurs applications correspondent (${error.candidates.join(', ')}). Laquelle souhaitez-vous consulter ?`,
    });
    return;
  }

  const classification = dependencies.classify({
    userRequest: request.message,
    availableReadOnlyTools: toolNames,
    knownContext,
  });
  if (classification.kind === 'mutation') {
    yield event({
      type: 'error', correlationId, code: 'FORBIDDEN', retryable: false,
      message: 'Le chat MCP est strictement en lecture seule et ne peut pas effectuer cette action.',
    });
    return;
  }
  if (classification.kind !== 'tool') {
    if (dependencies.registerClarification) {
      await dependencies.registerClarification({ conversationId, clarificationId: correlationId });
    }
    yield event({
      type: 'clarification_required', correlationId,
      question: 'Souhaitez-vous consulter les applications, un déploiement, des logs ou une recommandation FinOps ?',
    });
    return;
  }

  const tool = classification.tool;
  const args = buildToolArguments(tool, knownContext, dependencies.now());
  if (!args) {
    if (dependencies.registerClarification) {
      await dependencies.registerClarification({ conversationId, clarificationId: correlationId });
    }
    yield event({
      type: 'clarification_required', correlationId,
      question: 'Quelle application et quel environnement souhaitez-vous consulter ?',
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
    yield event({ type: 'error', correlationId, code: issue.code, message: issue.message, retryable: issue.retryable });
    return;
  }
  yield event({ type: 'answer_delta', correlationId, text: answerFor(tool, result) });
  yield event({
    type: 'turn_completed', correlationId,
    sources: result.meta.sources.map(({ source, status }) => ({ source, status })),
  });
  if (dependencies.confirmContext && Object.keys(knownContext.target).length) {
    await dependencies.confirmContext({ conversationId, knownContext: knownContext.target });
  }
}

function createChatService(mcpClient, buildKnownContext) {
  return {
    run: (request, runtime = {}) => runChatTurn(request, {
      mcpClient,
      classify: classifyWithFallback,
      buildKnownContext,
      now: () => new Date(),
      ...runtime,
    }),
  };
}

module.exports = { createChatService, runChatTurn };
