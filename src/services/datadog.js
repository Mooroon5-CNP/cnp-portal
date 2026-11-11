'use strict';

const client = require('../clients/datadog');

// Toutes les lectures prennent une liste de services DÉJÀ autorisés pour l'utilisateur
// (voir services/observability-scope.js). Une liste vide ne déclenche aucun appel Datadog.

// Portal-level access request workflow (not a Datadog native feature)
const accessRequests = [];

const RANGES = {
  '1h':  { seconds: 3600,   label: '1 heure' },
  '24h': { seconds: 86400,  label: '24 heures' },
  '7d':  { seconds: 604800, label: '7 jours' },
  'custom': { seconds: null, label: 'Dates précises…' },
};
const DEFAULT_RANGE = '24h';
const LEVELS = ['error', 'warn', 'info', 'debug'];
const LOGS_RETENTION_DAYS = 15;   // index « main » de Datadog
const MAX_CUSTOM_DAYS = 31;
const DAY = 86400;

function normalizeRange(range) {
  return Object.prototype.hasOwnProperty.call(RANGES, range) && range !== 'custom' ? range : DEFAULT_RANGE;
}

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : null;
}

// Recherche plein texte : on garde lettres, chiffres, espaces et quelques signes, sans guillemets ni
// opérateurs Datadog, pour que la saisie ne puisse jamais élargir le périmètre de la requête.
function normalizeSearch(text) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/[^\p{L}\p{N} _./:@-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return clean || null;
}

const isoDay = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const parseDay = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00`) : null);

// Fenêtre de temps d'une requête : une période glissante (1h, 24h, 7j) ou des dates précises
// (`from` et `to` au format AAAA-MM-JJ, jour de fin inclus, jamais dans le futur).
// Renvoie { range, from, to (secondes), label, fromDay, toDay, error }.
function resolveWindow({ range, from, to } = {}, now = Date.now()) {
  const nowSec = Math.floor(now / 1000);
  if (range === 'custom') {
    const start = parseDay(from);
    const end = parseDay(to);
    let error = null;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) error = 'Dates invalides.';
    else if (start > end) error = 'La date de début doit précéder la date de fin.';
    else if (start.getTime() > now) error = 'On ne peut pas observer le futur : choisissez des dates passées.';
    else if ((end - start) / 1000 / DAY + 1 > MAX_CUSTOM_DAYS) error = `Période limitée à ${MAX_CUSTOM_DAYS} jours.`;
    if (!error) {
      const fromSec = Math.floor(start.getTime() / 1000);
      const toSec = Math.min(nowSec, Math.floor(end.getTime() / 1000) + DAY);
      const fmt = d => d.toLocaleDateString('fr-FR');
      return { range: 'custom', from: fromSec, to: toSec, label: `du ${fmt(start)} au ${fmt(end)}`, fromDay: from, toDay: to, error: null };
    }
    const fallback = resolveWindow({ range: DEFAULT_RANGE }, now);
    return { ...fallback, error };
  }
  const key = normalizeRange(range);
  const fromSec = nowSec - RANGES[key].seconds;
  return { range: key, from: fromSec, to: nowSec, label: RANGES[key].label,
    fromDay: isoDay(new Date(fromSec * 1000)), toDay: isoDay(new Date(now)), error: null };
}

// Le texte lisible d'un log, quelle que soit sa source :
// - ECS (forwarder Lambda) et agent GKE : `message` ;
// - Cloud Run (push Pub/Sub) : l'entrée Cloud Logging brute est dans `attributes.data`.
function messageOf(attributes) {
  if (attributes.message) return String(attributes.message);
  const data = attributes.attributes?.data;
  if (data && typeof data === 'object') {
    if (data.textPayload) return String(data.textPayload);
    if (data.jsonPayload) {
      const j = data.jsonPayload;
      return String(j.message || j.msg || JSON.stringify(j));
    }
    if (data.httpRequest) {
      const h = data.httpRequest;
      return [h.requestMethod, h.requestUrl, h.status, h.latency].filter(Boolean).join(' ');
    }
    if (data.protoPayload?.methodName) return `${data.protoPayload.methodName} (audit)`;
  }
  return attributes.attributes?.['message.attributes']?.msg || '—';
}

function levelOf(attributes) {
  const raw = attributes.attributes?.data?.severity || attributes.status || 'info';
  const level = String(raw).toUpperCase().replace('WARNING', 'WARN');
  if (['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR'].includes(level)) return 'ERROR';
  if (level === 'NOTICE' || level === 'DEFAULT') return 'INFO';
  return ['DEBUG', 'INFO', 'WARN'].includes(level) ? level : 'INFO';
}

// Le nom de l'app d'un log : Cloud Run → `service` ; ECS → préfixe du flux de logs.
function serviceOf(attributes, allowed) {
  if (allowed.has(attributes.service)) return attributes.service;
  const stream = attributes.attributes?.aws?.awslogs?.logStream || '';
  const prefix = stream.split('/')[0];
  return allowed.has(prefix) ? prefix : null;
}

async function getLogs(services, { window = resolveWindow(), level = null, search = null, limit = 100 } = {}) {
  if (!services || services.length === 0) return [];
  const allowed = new Set(services);
  const raw = await client.searchServiceLogs({
    services, limit,
    from: new Date(window.from * 1000).toISOString(),
    to: new Date(window.to * 1000).toISOString(),
    level: normalizeLevel(level),
    text: normalizeSearch(search),
  });
  return raw.map(entry => {
    const a = entry.attributes || {};
    return {
      timestamp: a.timestamp || null,
      level: levelOf(a),
      service: serviceOf(a, allowed),
      source: a.attributes?.aws ? 'ECS' : (String(a.tags || '').includes('source:gcp.cloud.run') ? 'Cloud Run' : (a.source || '')),
      message: messageOf(a),
    };
  })
    // Défense en profondeur : un log qu'on ne sait pas rattacher à un service autorisé n'est pas affiché.
    .filter(log => log.service);
}

// Export CSV d'une liste de logs déjà filtrée. Une cellule commençant par = + - @ est préfixée
// d'une apostrophe pour qu'un tableur ne l'exécute pas comme formule.
function logsToCsv(logs) {
  const cell = v => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
    return `"${t.replace(/"/g, '""')}"`;
  };
  const rows = [['horodatage', 'niveau', 'application', 'source', 'message']]
    .concat(logs.map(l => [l.timestamp, l.level, l.service, l.source, l.message]));
  return '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

// Lien vers l'explorateur de logs Datadog, déjà filtré sur ces services et cette période.
function logsExplorerUrl(site, services, window) {
  if (!services || services.length === 0) return null;
  const base = `https://${String(site || 'datadoghq.com').replace(/^(api|app)\./, '')}`;
  const p = new URLSearchParams({ query: client.logsScopeQuery(services), from_ts: String(window.from * 1000), to_ts: String(window.to * 1000), live: 'false' });
  return `${base}/logs?${p}`;
}

const avg = pts => (pts && pts.length ? pts.reduce((s, p) => s + p[1], 0) / pts.length : null);
const sum = pts => (pts && pts.length ? pts.reduce((s, p) => s + p[1], 0) : null);
const max = pts => (pts && pts.length ? Math.max(...pts.map(p => p[1])) : null);
const last = pts => (pts && pts.length ? pts.reduce((a, b) => (b[0] > a[0] ? b : a))[1] : null);
const round1 = v => (v === null ? null : Math.round(v * 10) / 10);

const pctOf = v => (v === null ? null : round1(v * 100));
const ratio = (num, den) => (num !== null && den ? num / den : null);

// Une ligne par service : { service, cloudRun: {...}|null, ecs: {...}|null }.
async function getMetrics(services, window = resolveWindow()) {
  if (!services || services.length === 0) return [];
  const m = await client.getServiceMetrics(services, window.from, window.to);
  const pts = (key, service) => (m[key] && m[key][service]) || [];
  return services.map(service => {
    const hasRun = ['requests', 'latency', 'cpu', 'memory', 'instances'].some(k => pts(k, service).length);
    const hasEcs = ['ecsCpu', 'ecsMemory', 'ecsRunning'].some(k => pts(k, service).length);
    const requests = sum(pts('requests', service));
    const errors = sum(pts('errors', service));
    const billable = sum(pts('billable', service));
    const vcpu = ratio(sum(pts('cpuAlloc', service)), billable);
    const gib = ratio(sum(pts('memAlloc', service)), billable);
    return {
      service,
      cloudRun: hasRun ? {
        requests: requests === null ? null : Math.round(requests),
        errors: errors === null ? (requests === null ? null : 0) : Math.round(errors),
        errorRate: requests ? round1(((errors || 0) / requests) * 100) : null,
        latencyP95: round1(max(pts('latency', service))),
        cpu: pctOf(avg(pts('cpu', service))),
        cpuPeak: pctOf(max(pts('cpuPeak', service))),
        memory: pctOf(avg(pts('memory', service))),
        memoryPeak: pctOf(max(pts('memoryPeak', service))),
        instances: round1(avg(pts('instances', service))),
        instancesMax: round1(max(pts('instances', service))),
        // Arrondis aux valeurs que Cloud Run propose (0,25 vCPU près ; mémoire en Mio).
        size: vcpu === null ? null : { vcpu: Math.round(vcpu * 4) / 4, memoryMiB: gib === null ? null : Math.round(gib * 1024 / 64) * 64 },
      } : null,
      ecs: hasEcs ? {
        cpu: round1(avg(pts('ecsCpu', service))),
        cpuPeak: round1(max(pts('ecsCpuPeak', service))),
        memory: round1(avg(pts('ecsMemory', service))),
        memoryPeak: round1(max(pts('ecsMemoryPeak', service))),
        running: last(pts('ecsRunning', service)),
      } : null,
    };
  });
}

function serviceTagsOf(monitor) {
  return (monitor.tags || []).filter(t => t.startsWith('service:')).map(t => t.slice('service:'.length));
}

function normalizeMonitorState(state) {
  switch (state) {
    case 'Alert':   return 'ALERT';
    case 'Warn':    return 'WARN';
    case 'OK':      return 'OK';
    case 'No Data': return 'NO DATA';
    default:        return state || 'UNKNOWN';
  }
}

async function getAlerts(services) {
  if (!services || services.length === 0) return [];
  try {
    const allowed = new Set(services);
    const monitors = await client.listMonitors();
    return monitors
      .map(m => ({ m, app: serviceTagsOf(m).find(s => allowed.has(s)) }))
      .filter(({ app }) => app)
      .map(({ m, app }) => ({
        id: String(m.id),
        name: m.name,
        query: m.query,
        app,
        status: normalizeMonitorState(m.overall_state),
        silenced: m.options?.silenced ? Object.keys(m.options.silenced).length > 0 : false,
      }));
  } catch (err) {
    console.error('[datadog] getAlerts error:', err.message);
    return [];
  }
}

// Silencer un moniteur n'est permis que s'il porte un service autorisé.
async function silenceAlert(monitorId, services) {
  if (!/^\d+$/.test(String(monitorId))) throw new Error('Alerte inconnue.');
  const monitor = await client.getMonitor(monitorId);
  const allowed = new Set(services || []);
  if (!serviceTagsOf(monitor || {}).some(s => allowed.has(s))) {
    const err = new Error('Accès refusé : cette alerte ne concerne pas une application de votre équipe.');
    err.status = 403;
    throw err;
  }
  return client.silenceMonitor(Number(monitorId));
}

// Le service cible est vérifié par la route (il doit appartenir au périmètre de l'utilisateur).
async function createAlert({ name, query, app }) {
  return client.createMonitor({ name, query, tags: [`service:${app}`] });
}

async function requestAccess(userId, reason) {
  accessRequests.push({ userId, reason, requestedAt: new Date().toISOString(), approved: false });
  return { requested: true };
}

async function getAccessRequests() {
  return accessRequests;
}

async function approveAccess(requestIndex) {
  if (!accessRequests[requestIndex]) throw new Error('Request not found');
  accessRequests[requestIndex].approved = true;
  return accessRequests[requestIndex];
}

module.exports = {
  RANGES, DEFAULT_RANGE, LEVELS, LOGS_RETENTION_DAYS, normalizeRange, normalizeLevel, normalizeSearch, resolveWindow,
  logsToCsv, logsExplorerUrl, getLogs, getMetrics, getAlerts, silenceAlert, createAlert,
  requestAccess, getAccessRequests, approveAccess,
  // exportés pour les tests
  messageOf, levelOf, serviceOf,
};
