'use strict';

// Mock Datadog service — swap for real Datadog API v2 calls post-MVP.
// Uses env vars DATADOG_API_KEY and DATADOG_APP_KEY when real mode is enabled.

const mockLogs = [
  { timestamp: new Date(Date.now() - 30000).toISOString(), level: 'INFO',  service: 'cnp-portal', message: 'Request handled: GET /deployments 200 45ms',    app: 'cnp-portal' },
  { timestamp: new Date(Date.now() - 60000).toISOString(), level: 'ERROR', service: 'app-beta',   message: 'Connection refused to database on port 5432',    app: 'app-beta' },
  { timestamp: new Date(Date.now() - 90000).toISOString(), level: 'WARN',  service: 'app-alpha',  message: 'High memory usage detected: 87% of limit',       app: 'app-alpha' },
  { timestamp: new Date(Date.now() - 120000).toISOString(), level: 'INFO', service: 'cnp-portal', message: 'User login: alice via GitLab OAuth',              app: 'cnp-portal' },
  { timestamp: new Date(Date.now() - 150000).toISOString(), level: 'INFO', service: 'app-gamma',  message: 'Deployment triggered for ref: main',              app: 'app-gamma' },
];

const mockMetrics = {
  latency: { p50: 42, p95: 189, p99: 340, unit: 'ms' },
  errorRate: { value: 1.2, unit: '%' },
  saturation: { cpu: 18, memory: 62, unit: '%' },
  traffic: { rps: 23, unit: 'req/s' },
};

const mockAlerts = [
  { id: 'alert-001', name: 'High Error Rate', query: 'avg(last_5m):sum:trace.web.request.errors{env:prod} > 5', status: 'OK',       silenced: false, app: 'cnp-portal' },
  { id: 'alert-002', name: 'CrashLoopBackOff Detected', query: 'kubernetes.containers.restarts > 10', status: 'ALERT',   silenced: false, app: 'app-beta' },
  { id: 'alert-003', name: 'Memory Saturation',    query: 'avg(last_10m):avg:kubernetes.memory.usage_pct{*} > 85', status: 'WARN',    silenced: true,  app: 'app-alpha' },
];

const accessRequests = [];

async function getLogs(appFilter = null) {
  if (appFilter) return mockLogs.filter(l => l.app === appFilter);
  return mockLogs;
}

async function getMetrics() {
  return mockMetrics;
}

async function getAlerts(appFilter = null) {
  if (appFilter) return mockAlerts.filter(a => a.app === appFilter);
  return mockAlerts;
}

async function silenceAlert(alertId) {
  const alert = mockAlerts.find(a => a.id === alertId);
  if (!alert) throw new Error('Alert not found');
  alert.silenced = true;
  return alert;
}

async function createAlert(alert) {
  const newAlert = { id: `alert-${Date.now()}`, ...alert, status: 'OK', silenced: false };
  mockAlerts.push(newAlert);
  return newAlert;
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
