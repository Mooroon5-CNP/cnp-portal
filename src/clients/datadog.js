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

// Scope of the FinOps metrics query. `{app}` and `{env}` are replaced by the validated application
// and environment. Default: APM-style tags; Cloud Run integration metrics use `service_name:{app}-{env}`.
function mcpMetricsScope(applicationId, environment, template = process.env.MCP_METRICS_SCOPE || 'service:{app},env:{env}') {
  if (!/^[a-z0-9_.:{},-]+$/i.test(template) || !template.includes('{app}')) throw new Error('INVALID_METRIC_SCOPE');
  return template.replace(/\{app\}/g, applicationId).replace(/\{env\}/g, environment);
}

// App-scoped CPU/memory metrics. Values are percentages (0..100); set MCP_METRICS_RATIO=true for
// metrics expressed as ratios (0..1), such as gcp.run.container.cpu.utilizations.avg.
async function queryMcpMetrics(applicationId, environment, days) {
  if (!/^[a-z0-9-]+$/i.test(applicationId) || !['dev', 'prod'].includes(environment)) throw new Error('INVALID_INPUT');
  const to = Math.floor(Date.now() / 1000), from = to - days * 86400;
  const client = makeClient();
  const scope = mcpMetricsScope(applicationId, environment);
  const scale = process.env.MCP_METRICS_RATIO === 'true' ? 100 : 1;
  const query = async (metric) => {
    if (!/^[a-zA-Z0-9_.]+$/.test(metric)) throw new Error('INVALID_METRIC');
    const response = await client.get('/api/v1/query', { params: {
      query: `avg:${metric}{${scope}}`, from, to,
    } });
    return (response.data.series || []).flatMap((series) => series.pointlist || [])
      .map(([timestamp, value]) => [timestamp, Number.isFinite(value) ? value * scale : value])
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

// ---------------------------------------------------------------------------
// Observabilité par équipe : toutes les requêtes ci-dessous reçoivent une liste de services
// déjà autorisés (voir services/observability-scope.js) et n'en sortent jamais.
// ---------------------------------------------------------------------------

const SAFE_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function assertServices(services) {
  if (!Array.isArray(services) || services.length === 0) throw new Error('INVALID_SERVICES');
  for (const s of services) if (!SAFE_SERVICE.test(s)) throw new Error('INVALID_SERVICES');
}

// Cloud Run : `service:<nom>` ; ECS : le flux de logs commence par `<nom>/` (le champ `service`
// des logs ECS est choisi par l'app elle-même et ne correspond pas forcément au nom de la ressource).
// Cloud privé : cluster k3s sur une VM AWS. Chaque app y a son namespace `<app>-<env>` (= nom du service),
// seule clé fiable : les logs de l'app en prod portent `service:<app>` sans l'environnement.
const K3S_CLUSTER = 'cnp-prive';

function k3sScope(services) {
  return `kube_cluster_name:${K3S_CLUSTER} kube_namespace:(${services.join(' OR ')})`;
}

function logsScopeQuery(services) {
  assertServices(services);
  return `(service:(${services.join(' OR ')}) OR @aws.awslogs.logStream:(${services.map(s => `${s}\\/*`).join(' OR ')})`
    // Le journal d'audit de l'API k3s est un log de la plateforme, pas de l'app.
    + ` OR (${k3sScope(services)} -source:kubernetes.audit))`;
}

// `from` / `to` : dates ISO ou expressions Datadog (`now-1h`). `text` : mots à rechercher,
// déjà nettoyés par le service (ni guillemets, ni parenthèses, ni étoiles).
// Logs des bases de données des apps : Cloud SQL (GCP), RDS et PostgreSQL Azure (source:postgresql),
// PostgreSQL dans le namespace k3s (source:postgres).
const DATABASE_SOURCES = 'source:(gcp.cloudsql.database OR postgresql OR postgres)';
const ORIGIN_QUERY = { app: `-${DATABASE_SOURCES}`, db: DATABASE_SOURCES };

async function searchServiceLogs({ services, from = 'now-1h', to = 'now', limit = 100, level = null, text = null, origin = null }) {
  const parts = [logsScopeQuery(services)];
  if (level) parts.push(`status:${level}`);
  if (ORIGIN_QUERY[origin]) parts.push(ORIGIN_QUERY[origin]);
  // Chaque mot est cherché dans tous les champs du log (`*:`), pas seulement le message : sur ECS,
  // le chemin de la requête est dans un attribut (@path), et Cloud Run range son texte dans `data`.
  if (text) parts.push(...text.split(' ').filter(Boolean).map(word => `*:"${word}"`));
  try {
    const { data } = await makeClient().post('/api/v2/logs/events/search', {
      filter: { query: parts.join(' '), from, to },
      page: { limit },
      sort: '-timestamp',
    });
    return data.data || [];
  } catch (err) {
    handleError(err, 'searchServiceLogs');
  }
}

// Une requête par métrique, groupée par service : le coût ne dépend pas du nombre d'apps.
// Résout en { [service]: [[ts, value], ...] } ; une métrique absente donne {} (jamais d'erreur).
async function queryByService(client, query, from, to) {
  try {
    const r = await client.get('/api/v1/query', { params: { query, from, to } });
    const out = {};
    for (const s of r.data?.series || []) {
      // tag_set ne contient que les tags du « by {…} » ; scope répète aussi le filtre.
      const tag = (s.tag_set || []).find(t => /^(service_name|servicename|name|kube_namespace):/.test(t))
        || /^(?:service_name|servicename|name|kube_namespace):[^,]+/.exec(s.scope || '')?.[0];
      const name = tag?.split(':')[1];
      if (!name) continue;
      out[name] = (out[name] || []).concat((s.pointlist || []).filter(p => p[1] !== null && Number.isFinite(p[1])));
    }
    return out;
  } catch (_) {
    return {};
  }
}

// Métriques Cloud Run (intégration GCP), ECS (intégration AWS) et Container Apps (intégration Azure,
// tag `name:` = nom de l'app) des services donnés, entre
// `from` et `to` (secondes epoch).
async function getServiceMetrics(services, from, to) {
  assertServices(services);
  const client = makeClient();
  const run = services.map(s => `service_name:${s}`).join(' OR ');
  const ecs = services.map(s => `servicename:${s}`).join(' OR ');
  const az = services.map(s => `name:${s}`).join(' OR ');
  // Requête de métriques : les filtres se combinent par AND explicite (un espace ne suffit pas, contrairement aux logs).
  const k3s = `kube_cluster_name:${K3S_CLUSTER} AND kube_namespace:(${services.join(' OR ')})`;
  const q = query => queryByService(client, query, from, to);
  const entries = {
    requests:   `sum:gcp.run.request_count{${run}} by {service_name}.as_count()`,
    // 501 (méthode non gérée, ex. `HEAD /` envoyé par les robots qui scannent le web) n'est pas une panne de l'app.
    errors:     `sum:gcp.run.request_count{(${run}) AND response_code_class:5xx AND NOT response_code:501} by {service_name}.as_count()`,
    latency:    `max:gcp.run.request_latencies.p95{${run}} by {service_name}`,
    cpu:        `avg:gcp.run.container.cpu.utilizations.avg{${run}} by {service_name}`,
    cpuPeak:    `max:gcp.run.container.cpu.utilizations.p99{${run}} by {service_name}`,
    memory:     `avg:gcp.run.container.memory.utilizations.avg{${run}} by {service_name}`,
    memoryPeak: `max:gcp.run.container.memory.utilizations.p99{${run}} by {service_name}`,
    instances:  `sum:gcp.run.container.instance_count{${run}} by {service_name}`,
    // Taille d'une instance = temps alloué / temps d'instance facturé (vCPU·s / s, Gio·s / s).
    cpuAlloc:   `sum:gcp.run.container.cpu.allocation_time{${run}} by {service_name}.as_count()`,
    memAlloc:   `sum:gcp.run.container.memory.allocation_time{${run}} by {service_name}.as_count()`,
    billable:   `sum:gcp.run.container.billable_instance_time{${run}} by {service_name}.as_count()`,
    ecsCpu:     `avg:aws.ecs.service.cpuutilization{${ecs}} by {servicename}`,
    ecsCpuPeak: `max:aws.ecs.service.cpuutilization.maximum{${ecs}} by {servicename}`,
    ecsMemory:  `avg:aws.ecs.service.memory_utilization{${ecs}} by {servicename}`,
    ecsMemoryPeak: `max:aws.ecs.service.memory_utilization.maximum{${ecs}} by {servicename}`,
    ecsRunning: `sum:aws.ecs.service.running{${ecs}} by {servicename}`,
    azRequests: `sum:azure.app_containerapps.requests{${az}} by {name}.as_count()`,
    azErrors:   `sum:azure.app_containerapps.requests{(${az}) AND statuscodecategory:5xx AND NOT statuscode:501} by {name}.as_count()`,
    azLatency:  `avg:azure.app_containerapps.response_time{${az}} by {name}`,
    azLatencyPeak: `max:azure.app_containerapps.response_time{${az}} by {name}`,
    azCpu:      `avg:azure.app_containerapps.cpu_percentage{${az}} by {name}`,
    azCpuPeak:  `max:azure.app_containerapps.cpu_percentage{${az}} by {name}`,
    azMemory:   `avg:azure.app_containerapps.memory_percentage{${az}} by {name}`,
    azMemoryPeak: `max:azure.app_containerapps.memory_percentage{${az}} by {name}`,
    azReplicas: `avg:azure.app_containerapps.replicas{${az}} by {name}`,
    // k3s : total du namespace (l'app et sa base PostgreSQL) à chaque instant.
    k3sCpu:     `sum:kubernetes.cpu.usage.total{${k3s}} by {kube_namespace}`,
    k3sMemory:  `sum:kubernetes.memory.usage{${k3s}} by {kube_namespace}`,
    k3sPods:    `sum:kubernetes_state.deployment.replicas_available{${k3s}} by {kube_namespace}`,
  };
  const keys = Object.keys(entries);
  const values = await Promise.all(keys.map(k => q(entries[k])));
  return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
}

// Les moniteurs n'ont pas de filtre « OU » fiable côté API : on les lit tous puis on ne garde
// que ceux tagués `service:<nom>` pour un service autorisé.
async function listMonitors() {
  try {
    const { data } = await makeClient().get('/api/v1/monitor');
    return Array.isArray(data) ? data : [];
  } catch (err) {
    handleError(err, 'listMonitors');
  }
}

async function getMonitor(monitorId) {
  try {
    const { data } = await makeClient().get(`/api/v1/monitor/${Number(monitorId)}`);
    return data;
  } catch (err) {
    handleError(err, `getMonitor(${monitorId})`);
  }
}

module.exports = { K3S_CLUSTER, logsScopeQuery, searchServiceLogs, getServiceMetrics, listMonitors, getMonitor, searchMcpLogs, queryMcpMetrics, mcpMetricsScope, getGoldenSignals, getLogs, getMonitors, silenceMonitor, createMonitor, checkConnectivity };
