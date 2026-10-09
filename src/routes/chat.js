'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { createLogger } = require('../middleware/logger');
const deploymentModel = require('../models/deployment');
const chatService = require('../services/chat');
const aiClient = require('../clients/aiClient');

const router = express.Router();
const logger = createLogger();

function registeredApps() {
  try {
    return [...new Set(deploymentModel.listForUser(null).map(d => d.app_name).filter(Boolean))].sort();
  } catch (_) {
    return [];
  }
}

// JSON flavour of requireAuth: the chat API never redirects.
function requireChatUser(req, res, next) {
  const correlationId = uuidv4();
  if (!req.session || !req.session.userId || !req.user) {
    return res.status(401).json(chatService.errorEvent('UNAUTHENTICATED', correlationId).data);
  }
  if (!req.user.active) {
    return res.status(403).json(chatService.errorEvent('FORBIDDEN', correlationId).data);
  }
  // Cross-site protection: JSON body only, and same origin when the browser sends one.
  const origin = req.get('origin');
  let sameOrigin = true;
  if (origin) {
    try { sameOrigin = new URL(origin).host === req.get('host'); } catch (_) { sameOrigin = false; }
  }
  if (!req.is('application/json') || !sameOrigin) {
    return res.status(403).json(chatService.errorEvent('FORBIDDEN', correlationId).data);
  }
  next();
}

router.get('/chat', requireAuth, (req, res) => {
  res.render('chat/index', {
    title: 'Assistant CNP — CNP Portal',
    user: req.user,
    currentPage: 'chat',
    apps: registeredApps(),
    environments: chatService.ENVIRONMENTS,
  });
});

router.post('/api/v1/mcp/chat/turn', requireChatUser, async (req, res) => {
  const correlationId = uuidv4();
  const parsed = chatService.validateTurnRequest(req.body);
  if (!parsed.ok) {
    return res.status(400).json(chatService.errorEvent('INVALID_INPUT', correlationId).data);
  }
  const { message, conversationId, context } = parsed.value;
  const knownContext = chatService.buildKnownContext({ message, context }, registeredApps());

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Correlation-Id': correlationId,
  });
  const send = ({ type, data }) => {
    if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const controller = new AbortController();
  const timeoutMs = parseInt(process.env.AI_CLIENT_TIMEOUT_MS || '60000', 10);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const started = Date.now();
  let outcome = 'incomplete';
  let finished = false;
  try {
    let token = null;
    if (aiClient.needsToken()) {
      try {
        token = chatService.issueInternalToken(req.user, process.env.CHAT_INTERNAL_TOKEN_SECRET);
      } catch (e) {
        throw new aiClient.AiClientError('AI_CLIENT_UNAVAILABLE', e.message);
      }
    }
    await aiClient.streamTurn({
      token,
      signal: controller.signal,
      payload: { conversationId, correlationId, userRequest: message, knownContext },
      onEvent: (event) => {
        if (finished) return;
        const safe = chatService.sanitizeEvent(event, correlationId);
        if (!safe) return;
        if (safe.type === 'completed' || safe.type === 'error') {
          finished = true;
          outcome = safe.type === 'error' ? safe.data.code : safe.data.status;
        }
        send(safe);
      },
    });
    if (!finished) {
      outcome = 'AI_CLIENT_UNAVAILABLE';
      send(chatService.errorEvent('AI_CLIENT_UNAVAILABLE', correlationId));
    }
  } catch (e) {
    const code = e instanceof aiClient.AiClientError ? e.code : 'INTERNAL_ERROR';
    outcome = code;
    logger.warn({ message: 'chat turn failed', correlationId, code, detail: e.detail || e.message });
    if (!finished) send(chatService.errorEvent(code, correlationId));
  } finally {
    clearTimeout(timer);
    // Audit without the raw user message.
    logger.info({
      message: 'chat turn',
      correlationId,
      conversationId,
      userId: req.user.id,
      applicationId: knownContext.applicationId || null,
      environment: knownContext.environment || null,
      outcome,
      duration_ms: Date.now() - started,
    });
    res.end();
  }
});

module.exports = router;
