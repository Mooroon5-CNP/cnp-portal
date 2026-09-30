'use strict';

const express = require('express');
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

function createRouter({ requireAuth, chatService, catalog }) {
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
    });
  });

  router.get('/api/v1/mcp/catalog', requireAuth, async (_req, res) => {
    const applications = await catalog.listApplications();
    res.json({ applications });
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
      const confirmedConversationContext = req.body.conversationId
        ? confirmedContexts[req.body.conversationId] : undefined;
      for await (const event of chatService.run(req.body, {
        actor: { userId: req.user.id, roles: [req.user.role], authenticated: true },
        allowedTools: ['list_applications', 'get_deployment_status', 'get_application_logs', 'get_finops_recommendation'],
        pageContext: req.session.mcpPageContext,
        confirmedConversationContext,
        pendingClarificationId: req.body.conversationId
          ? pendingClarifications[req.body.conversationId] : undefined,
        registerClarification: async ({ conversationId, clarificationId }) => {
          pendingClarifications[conversationId] = clarificationId;
        },
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
        code: invalid ? 'INVALID_INPUT' : 'INTERNAL_ERROR',
        message: invalid ? 'La demande ne respecte pas le format attendu.' : 'Le service MCP est temporairement indisponible.',
        retryable: !invalid,
      });
    }
    return res.end();
  });

  return router;
}

module.exports = { createRouter };
