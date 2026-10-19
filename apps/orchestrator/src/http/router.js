'use strict';

const express = require('express');
const { commands } = require('../commands');
const { randomBytes, timingSafeEqual } = require('crypto');
const { ZodError } = require('zod');

function csrfToken(req) {
  if (!req.session.mcpCsrfToken) {
    req.session.mcpCsrfToken = randomBytes(32).toString('hex');
  }
  return req.session.mcpCsrfToken;
}

function validCsrf(req) {
  const expected = csrfToken(req);
  const received = req.get('x-cnp-csrf') || '';
  if (received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function writeEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function contextMap(req) {
  if (!req.session.mcpConfirmedContexts) req.session.mcpConfirmedContexts = {};
  return req.session.mcpConfirmedContexts;
}

function clarificationMap(req) {
  if (!req.session.mcpPendingClarifications) req.session.mcpPendingClarifications = {};
  return req.session.mcpPendingClarifications;
}

function describeError(error) {
  const messages = {
    MCP_UNAUTHENTICATED: 'Authentification MCP refusée : le JWT est expiré ou ne correspond pas au serveur. Relancez npm run dev:integration.',
    MCP_FORBIDDEN: 'Accès MCP refusé : vérifiez MCP_ORIGIN, les hôtes autorisés et le scope cnp:read.',
    MCP_ENDPOINT_INVALID: 'Adresse MCP incorrecte : MCP_URL doit pointer vers le serveur MCP (port 3000), pas vers le portail (port 3001).',
    MCP_UNREACHABLE: 'Le serveur MCP est arrêté ou son port est incorrect. Lancez npm run dev:integration.',
    MCP_TIMEOUT: 'Le serveur MCP ne répond pas dans le délai prévu.',
    INVALID_MCP_RESPONSE: 'La réponse MCP ne respecte pas le contrat du portail.',
  };
  return messages[error.code] || 'Le service MCP est temporairement indisponible.';
}

function createRouter({ requireAuth, chatService, catalog, runtimeForUser, dataMode = 'mock' }) {
  const router = express.Router();

  router.get('/mcp-chat', requireAuth, (req, res) => {
    req.session.mcpPageContext = {
      ...(typeof req.query.applicationId === 'string' ? { applicationId: req.query.applicationId } : {}),
      ...(typeof req.query.environment === 'string' ? { environment: req.query.environment } : {}),
    };
    res.render('mcp-chat/index', {
      title: 'Assistant MCP — CNP Portal',
      currentPage: 'mcp-chat',
      csrfToken: csrfToken(req),
      commands,
      dataMode: dataMode === 'real' ? 'Données réelles' : 'Données de test',
    });
  });

  router.get('/api/v1/mcp/catalog', requireAuth, async (req, res, next) => {
    try {
      const source = runtimeForUser ? runtimeForUser(req.user).catalog : catalog;
      const applications = await source.listApplications();
      res.json({ applications });
    } catch (error) {
      if (!error.code || !error.code.startsWith('MCP_')) return next(error);
      return res.status(502).json({ code: error.code, message: describeError(error) });
    }
  });

  router.post('/api/v1/mcp/chat/turn', requireAuth, async (req, res) => {
    if (!validCsrf(req)) {
      return res.status(403).json({ code: 'FORBIDDEN', message: 'Invalid CSRF token.' });
    }
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    try {
      const confirmedContexts = contextMap(req);
      const pendingClarifications = clarificationMap(req);
      const storedPending = req.body.conversationId ? pendingClarifications[req.body.conversationId] : undefined;
      const pendingRequest = storedPending && typeof storedPending === 'object' && storedPending.expiresAt > Date.now()
        ? storedPending : undefined;
      const confirmedConversationContext = req.body.conversationId
        ? confirmedContexts[req.body.conversationId] : undefined;
      for await (const event of chatService.run(req.body, {
        ...(runtimeForUser ? runtimeForUser(req.user) : {}),
        actor: { userId: String(req.user.id), roles: [req.user.role], authenticated: true },
        allowedTools: ['list_applications', 'get_deployment_status', 'get_application_logs', 'get_finops_recommendation'],
        pageContext: req.session.mcpPageContext,
        confirmedConversationContext,
        pendingRequest,
        pendingClarificationId: pendingRequest?.clarificationId,
        registerClarification: async ({ conversationId, clarificationId, tool, target }) => {
          pendingClarifications[conversationId] = { clarificationId, tool, target, expiresAt: Date.now() + 15 * 60 * 1000 };
          const ids = Object.keys(pendingClarifications);
          if (ids.length > 20) delete pendingClarifications[ids[0]];
        },
        clearClarification: async ({ conversationId }) => { delete pendingClarifications[conversationId]; },
        confirmContext: async ({ conversationId, knownContext }) => {
          confirmedContexts[conversationId] = knownContext;
          delete pendingClarifications[conversationId];
          const ids = Object.keys(confirmedContexts);
          if (ids.length > 20) delete confirmedContexts[ids[0]];
        },
      })) {
        writeEvent(res, event);
      }
    } catch (error) {
      const correlationId = require('uuid').v4();
      const invalid = error instanceof ZodError;
      writeEvent(res, {
        type: 'error', correlationId,
        code: invalid ? 'INVALID_INPUT' : (error.code || 'INTERNAL_ERROR'),
        message: invalid ? 'La demande ne respecte pas le format attendu.' : describeError(error),
        retryable: !invalid,
      });
    }
    return res.end();
  });

  return router;
}

module.exports = { createRouter, describeError };
