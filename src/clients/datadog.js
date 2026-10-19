'use strict';

const axios = require('axios');
const { config } = require('../config/env');

function makeClient() {
  if (!config.datadog.apiKey || !config.datadog.appKey) {
    throw new Error('Datadog credentials not configured (DD_API_KEY, DD_APP_KEY)');
  }

  return axios.create({
    baseURL: `https://api.${config.datadog.site}`,
    timeout: 15000,
    headers: {
      'DD-API-KEY': config.datadog.apiKey,
      'DD-APPLICATION-KEY': config.datadog.appKey,
      'Content-Type': 'application/json',
    },
  });
}

function handleError(err, context) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    throw new Error(`Datadog unreachable at api.${config.datadog.site}: ${err.message}`);
  }
  if (err.response) {
    const status = err.response.status;
    if (status === 403) throw new Error('Datadog authentication failed. Check DD_API_KEY and DD_APP_KEY.');
    if (status === 429) throw new Error('Datadog rate limit exceeded.');
    throw new Error(`Datadog API error (${status}) on ${context}: ${err.response.data?.errors?.join(', ') || err.message}`);
  }
  if (err.code === 'ECONNABORTED') throw new Error(`Datadog request timed out: ${context}`);
  throw new Error(`Datadog request failed (${context}): ${err.message}`);
}

function extractLastPoint(data) {
  const points = data?.series?.[0]?.pointlist || [];
  const last = points.filter(p => p[1] !== null).pop();
  return last ? last[1] : null;
}

// 4 golden signals for a given service name (uses DD trace + system metrics)
async function getGoldenSignals(serviceName) {
  const client = makeClient();
  const now = Math.floor(Date.now() / 1000);
  const from = now - 300;

  function query(q) {
    return client.get('/api/v1/query', { params: { query: q, from, to: now } })
      .then(r => extractLastPoint(r.data))
      .catch(() => null);
  }

  const [p50ns, p95ns, p99ns, errorRateRaw, cpuRaw, memUsableRaw, rpsRaw] = await Promise.all([
    query(`avg:trace.web.request.duration.by.service.p50{service:${serviceName}}`),
    query(`avg:trace.web.request.duration.by.service.p95{service:${serviceName}}`),
    query(`avg:trace.web.request.duration.by.service.p99{service:${serviceName}}`),
    query(`avg:trace.web.request.error_rate{service:${serviceName}}`),
    query(`avg:system.cpu.user{service:${serviceName}}`),
    query(`avg:system.mem.pct_usable{service:${serviceName}}`),
    query(`avg:trace.web.request{service:${serviceName}}.as_rate()`),
  ]);

  // Datadog trace durations are in nanoseconds
  const nsToMs = v => v !== null ? Math.round(v / 1e6) : '—';
  const toPct  = v => v !== null ? Math.round(v * 10) / 10 : '—';
  const toRate = v => v !== null ? Math.round(v * 10) / 10 : '—';

  return {
    latency: {
      p50: nsToMs(p50ns),
      p95: nsToMs(p95ns),
      p99: nsToMs(p99ns),
      unit: 'ms',
    },
    errorRate: {
      value: toPct(errorRateRaw !== null ? errorRateRaw * 100 : null),
      unit: '%',
    },
    saturation: {
      cpu: toPct(cpuRaw),
      memory: toPct(memUsableRaw !== null ? (1 - memUsableRaw) * 100 : null),
      unit: '%',
    },
    traffic: {
      rps: toRate(rpsRaw),
      unit: 'req/s',
    },
  };
}

async function getLogs(serviceName, limit = 50) {
  const client = makeClient();
  try {
    const { data } = await client.post('/api/v2/logs/events/search', {
      filter: { query: `service:${serviceName}`, from: 'now-1h', to: 'now' },
      page: { limit },
      sort: '-timestamp',
    });
    return data.data || [];
  } catch (err) {
    handleError(err, `getLogs(${serviceName})`);
  }
}

// Bounded MCP log search: propagate errors instead of silently returning empty data.
async function searchMcpLogs(input) {
  if (!/^[a-z0-9-]+$/i.test(input.applicationId)) throw new Error('INVALID_INPUT');
  const parts = [`service:${input.applicationId}`, `env:${input.environment}`];
  if (input.levels?.length) parts.push(`status:(${input.levels.map((level) => level.toLowerCase()).join(' OR ')})`);
  if (input.query) parts.push(`"${input.query}"`);
  const { data } = await makeClient().post('/api/v2/logs/events/search', {
    filter: { query: parts.join(' '), from: input.from, to: input.to },
    page: { limit: input.limit, ...(input.cursor ? { cursor: input.cursor } : {}) }, sort: 'timestamp',
  });
  const nextCursor = data.meta?.page?.after || null;
  return { nextCursor, truncated: Boolean(nextCursor), logs: (data.data || []).map((entry) => {
    const attributes = entry.attributes || {};
    const level = String(attributes.status || '').toUpperCase().replace('WARNING', 'WARN');
    return { timestamp: attributes.timestamp, level: ['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(level) ? level : 'UNKNOWN',
      message: attributes.message || '', service: attributes.service || input.applicationId,
      version: attributes.attributes?.version || null, correlationId: attributes.attributes?.correlation_id || null };
  }) };
}

// Configure app-scoped metrics whose values are already percentages (0..100).
async function queryMcpMetrics(applicationId, environment, days) {
  if (!/^[a-z0-9-]+$/i.test(applicationId)) throw new Error('INVALID_INPUT');
  const to = Math.floor(Date.now() / 1000), from = to - days * 86400;
  const client = makeClient();
  const query = async (metric) => {
    if (!/^[a-zA-Z0-9_.]+$/.test(metric)) throw new Error('INVALID_METRIC');
    const response = await client.get('/api/v1/query', { params: {
      query: `avg:${metric}{service:${applicationId},env:${environment}}`, from, to,
    } });
    return (response.data.series || []).flatMap((series) => series.pointlist || [])
      .filter(([timestamp, value]) => Number.isFinite(timestamp) && Number.isFinite(value) && value >= 0 && value <= 100);
  };
  const [cpu, memory] = await Promise.all([query(process.env.MCP_CPU_PERCENT_METRIC), query(process.env.MCP_MEMORY_PERCENT_METRIC)]);
  const mean = (points) => points.length ? points.reduce((sum, point) => sum + point[1], 0) / points.length : null;
  const peak = (points) => points.length ? Math.max(...points.map((point) => point[1])) : null;
  const coverage = (points) => points.length > 1 ? Math.floor((Math.max(...points.map((p) => p[0])) - Math.min(...points.map((p) => p[0]))) / 86400000) : 0;
  return { averageCpuPercent: mean(cpu), peakCpuPercent: peak(cpu), averageMemoryPercent: mean(memory),
    peakMemoryPercent: peak(memory), coverageDays: Math.min(coverage(cpu), coverage(memory)) };
}

async function getMonitors(serviceName) {
  const client = makeClient();
  try {
    const { data } = await client.get('/api/v1/monitor', {
      params: { tags: `service:${serviceName}` },
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    handleError(err, `getMonitors(${serviceName})`);
  }
}

async function silenceMonitor(monitorId) {
  const client = makeClient();
  try {
    const { data } = await client.post(`/api/v1/monitor/${monitorId}/mute`, {});
    return data;
  } catch (err) {
    handleError(err, `silenceMonitor(${monitorId})`);
  }
}

async function createMonitor({ name, query, tags = [] }) {
  const client = makeClient();
  try {
    const { data } = await client.post('/api/v1/monitor', {
      name,
      type: 'metric alert',
      query,
      message: `Alert: ${name}`,
      tags,
    });
    return data;
  } catch (err) {
    handleError(err, `createMonitor(${name})`);
  }
}

async function checkConnectivity() {
  const client = makeClient();
  try {
    await client.get('/api/v1/validate');
  } catch (err) {
    handleError(err, 'checkConnectivity');
  }
}

module.exports = { searchMcpLogs, queryMcpMetrics, getGoldenSignals, getLogs, getMonitors, silenceMonitor, createMonitor, checkConnectivity };
