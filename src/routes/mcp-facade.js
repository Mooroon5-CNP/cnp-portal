'use strict';

// Read-only source facades for the remote MCP server (MCP-CNP, ADAPTER_MODE=http).
// The MCP calls these routes with `Authorization: Bearer <MCP_FACADE_TOKEN>`; they reuse the
// portal's native adapters (GitHub config repo, Argo CD, Kubernetes, Datadog) and return the
// exact shapes of MCP-CNP apps/mcp-server/src/http-adapters.ts. Without a token the router is
// inert, so /v1 does not exist. Mounted before the session: no cookie, no login redirect.

const express = require('express');
const { createHash, timingSafeEqual } = require('crypto');

class SourceError extends Error {
  constructor(code, source) { super(code); this.code = code; this.source = source; }
}

const ID = /^[a-z0-9][a-z0-9-]{0,199}$/i;
const ENVIRONMENTS = new Set(['dev', 'prod']);
const LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// Same bounds as the MCP input contract (packages/contracts): cursors up to 1000 characters.
const CURSOR = /^[A-Za-z0-9_\-=+/.:]{1,1000}$/;
const METRIC_DAYS = new Set([7, 14, 30]);

const invalid = () => new SourceError('INVALID_INPUT', 'facade');
const digest = value => createHash('sha256').update(value).digest();

function httpStatus(code) {
  if (code === 'APPLICATION_NOT_FOUND' || code === 'ENVIRONMENT_NOT_FOUND') return 404;
  if (code === 'INVALID_INPUT') return 400;
  return 503;
}

function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw invalid(); return value; }
function environment(value) { if (!ENVIRONMENTS.has(value)) throw invalid(); return value; }
function optionalText(value, max = 200) {
  if (value === undefined) return undefined;
  // The Datadog search embeds the text in a quoted phrase: refuse quotes and escapes.
  if (typeof value !== 'string' || !value.length || value.length > max || /["\\]/.test(value)
    || [...value].some(char => char.charCodeAt(0) < 0x20)) throw invalid();
  return value;
}
function integer(value, { min, max, fallback }) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) throw invalid();
  const number = Number(value);
  if (number < min || number > max) throw invalid();
  return number;
}
function cursor(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CURSOR.test(value)) throw invalid();
  return value;
}
function isoDate(value) {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) throw invalid();
  return value;
}
function levels(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid();
  const list = value.split(',');
  if (!list.length || list.length > LEVELS.size || list.some(level => !LEVELS.has(level))) throw invalid();
  return [...new Set(list)];
}

function createMcpFacadeRouter({ token = process.env.MCP_FACADE_TOKEN, adapters, logger } = {}) {
  const router = express.Router();
  if (!token || Buffer.byteLength(token) < 32) return router;
  const expected = digest(token);
  let sources = adapters;
  const source = () => {
    if (!sources) sources = require('../../apps/orchestrator/src/sources/native-adapters.cjs').createNativeAdapters({ SourceError });
    return sources;
  };

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const started = Date.now();
    res.on('finish', () => logger?.info?.({ message: 'mcp facade request', method: req.method,
      path: req.baseUrl + req.path, status: res.statusCode, duration_ms: Date.now() - started }));
    const match = /^Bearer ([^\s]+)$/.exec(req.get('authorization') || '');
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'UNAUTHENTICATED' });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
    next();
  });

  const handle = read => async (req, res) => {
    try {
      res.json(await read(req));
    } catch (error) {
      const code = error instanceof SourceError ? error.code : 'SOURCE_UNAVAILABLE';
      res.status(httpStatus(code)).json({ error: code });
    }
  };

  router.get('/applications', handle(req => source().platform.list({
    query: optionalText(req.query.query),
    environment: req.query.environment === undefined ? undefined : environment(req.query.environment),
    limit: integer(req.query.limit, { min: 1, max: 100, fallback: 20 }),
    cursor: cursor(req.query.cursor),
  })));
  router.get('/applications/:id', handle(req => source().platform.get(id(req.params.id))));
  router.get('/applications/:id/:env/workload', handle(req =>
    source().platform.workload(id(req.params.id), environment(req.params.env))));
  router.get('/desired-state/:id/:env', handle(req =>
    source().git.desired(id(req.params.id), environment(req.params.env))));
  router.get('/deployment-status/:id/:env', handle(req =>
    source().argo.observed(id(req.params.id), environment(req.params.env))));
  router.get('/image-digest/:id/:env', handle(req =>
    source().kubernetes.imageDigest(id(req.params.id), environment(req.params.env))));
  router.get('/logs', handle(req => {
    const from = isoDate(req.query.from);
    const to = isoDate(req.query.to);
    if (Date.parse(from) > Date.parse(to)) throw invalid();
    return source().datadog.logs({
      applicationId: id(req.query.applicationId), environment: environment(req.query.environment), from, to,
      limit: integer(req.query.limit, { min: 1, max: 200, fallback: 50 }), levels: levels(req.query.levels),
      query: optionalText(req.query.query), cursor: cursor(req.query.cursor),
    });
  }));
  router.get('/metrics/:id/:env', handle(req => {
    const days = integer(req.query.days, { min: 1, max: 30, fallback: 7 });
    if (!METRIC_DAYS.has(days)) throw invalid();
    return source().datadog.metrics(id(req.params.id), environment(req.params.env), days);
  }));
  router.use((_req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  return router;
}

module.exports = { createMcpFacadeRouter, SourceError };
