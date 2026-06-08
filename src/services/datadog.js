'use strict';

const client = require('../clients/datadog');

// Portal-level access request workflow (not a Datadog native feature)
const accessRequests = [];

const SERVICE_NAME = process.env.DD_SERVICE || 'cnp-portal';

async function getLogs(serviceFilter = null) {
  try {
    const service = serviceFilter || SERVICE_NAME;
    const rawLogs = await client.getLogs(service, 100);
    return rawLogs.map(entry => ({
      timestamp: entry.attributes?.timestamp || new Date().toISOString(),
      level:     (entry.attributes?.status || 'info').toUpperCase().replace('WARNING', 'WARN'),
      service:   entry.attributes?.service || service,
      message:   entry.attributes?.message || entry.attributes?.['message.attributes']?.msg || '—',
    }));
  } catch (err) {
    console.error('[datadog] getLogs error:', err.message);
    return [];
  }
}

async function getMetrics() {
  try {
    return await client.getGoldenSignals(SERVICE_NAME);
  } catch (err) {
    console.error('[datadog] getMetrics error:', err.message);
    // Return a shape with '—' values so the view doesn't crash
    return {
      latency:    { p50: '—', p95: '—', p99: '—', unit: 'ms' },
      errorRate:  { value: '—', unit: '%' },
      saturation: { cpu: '—', memory: '—', unit: '%' },
      traffic:    { rps: '—', unit: 'req/s' },
    };
  }
}

async function getAlerts(serviceFilter = null) {
  try {
    const service = serviceFilter || SERVICE_NAME;
    const monitors = await client.getMonitors(service);
    return monitors.map(m => ({
      id:      String(m.id),
      name:    m.name,
      query:   m.query,
      app:     (m.tags || []).find(t => t.startsWith('service:'))?.replace('service:', '') || service,
      status:  normalizeMonitorState(m.overall_state),
      silenced: m.options?.silenced ? Object.keys(m.options.silenced).length > 0 : false,
    }));
  } catch (err) {
    console.error('[datadog] getAlerts error:', err.message);
    return [];
  }
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

async function silenceAlert(monitorId) {
  return client.silenceMonitor(Number(monitorId));
}

async function createAlert({ name, query, app }) {
  const tags = app ? [`service:${app}`] : [`service:${SERVICE_NAME}`];
  return client.createMonitor({ name, query, tags });
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

module.exports = { getLogs, getMetrics, getAlerts, silenceAlert, createAlert, requestAccess, getAccessRequests, approveAccess };
