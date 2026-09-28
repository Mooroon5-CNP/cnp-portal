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

  // Cloud Run GCP metrics (requires the GCP integration in Datadog). query() never rejects —
  // it resolves to null when a metric is missing — so an inactive integration only yields '—'
  // here and never affects the golden signals above.
  const [crReqRaw, crCpuRaw, crMemRaw] = await Promise.all([
    query(`sum:gcp.run.request_count{service_name:${serviceName}}.as_count()`),
    query(`avg:gcp.run.container.cpu.utilizations{service_name:${serviceName}}`),
    query(`avg:gcp.run.container.memory.utilizations{service_name:${serviceName}}`),
  ]);
  const cloudRun = {
    requests: crReqRaw !== null ? Math.round(crReqRaw) : '—',
    cpu:      toPct(crCpuRaw !== null ? crCpuRaw * 100 : null),
    memory:   toPct(crMemRaw !== null ? crMemRaw * 100 : null),
  };

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
    cloudRun,
  };
}

// Kubernetes usage per namespace, from the Datadog Agent's kubernetes.* / kubernetes_state.*
// metrics. Works for any app without instrumentation (unlike APM), as long as the Agent runs on
// the cluster. One query per metric, grouped by namespace, so the cost does not grow with the
// number of namespaces. Values are '—' for a namespace that reports nothing (e.g. not deployed).
async function getKubernetesUsage(namespaces) {
  const client = makeClient();
  const now = Math.floor(Date.now() / 1000);
  const from = now - 300;
  const scope = namespaces.map(ns => `kube_namespace:${ns}`).join(' OR ');

  // Resolves to { [namespace]: lastValue }; never rejects (a missing metric just yields {}).
  function byNamespace(q) {
    return client.get('/api/v1/query', { params: { query: `${q}{${scope}} by {kube_namespace}`, from, to: now } })
      .then(r => {
        const out = {};
        for (const s of r.data?.series || []) {
          const ns = /(?:^|,)kube_namespace:([^,()\s]+)/.exec(s.scope || '')?.[1];
          const last = (s.pointlist || []).filter(p => p[1] !== null).pop();
          if (ns && last) out[ns] = last[1];
        }
        return out;
      })
      .catch(() => ({}));
  }

  const [cpu, memory, pods, restarts] = await Promise.all([
    byNamespace('sum:kubernetes.cpu.usage.total'),   // nanocores
    byNamespace('sum:kubernetes.memory.usage'),      // bytes
    byNamespace('sum:kubernetes.pods.running'),
    byNamespace('sum:kubernetes_state.container.restarts'),
  ]);

  const round1 = v => Math.round(v * 10) / 10;
  const pick = (metric, ns, fn) => (metric[ns] !== undefined ? fn(metric[ns]) : '—');

  const usage = {};
  for (const ns of namespaces) {
    usage[ns] = {
      pods:     pick(pods, ns, Math.round),
      cpu:      pick(cpu, ns, v => round1(v / 1e6)),               // millicores
      memory:   pick(memory, ns, v => Math.round(v / 1048576)),    // MiB
      restarts: pick(restarts, ns, Math.round),
    };
  }
  return usage;
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

async function getMonitors(serviceName) {
  const client = makeClient();
  try {
    // monitor_tags filters on the tags set on the monitor itself; the `tags` param would filter
    // on scope tags (host:…) and never match `service:{app}`.
    const { data } = await client.get('/api/v1/monitor', {
      params: { monitor_tags: `service:${serviceName}` },
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

async function unsilenceMonitor(monitorId) {
  const client = makeClient();
  try {
    const { data } = await client.post(`/api/v1/monitor/${monitorId}/unmute`, {});
    return data;
  } catch (err) {
    handleError(err, `unsilenceMonitor(${monitorId})`);
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

module.exports = { getGoldenSignals, getKubernetesUsage, getLogs, getMonitors, silenceMonitor, unsilenceMonitor, createMonitor, checkConnectivity };
