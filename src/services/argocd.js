'use strict';

// Mock ArgoCD service — swap for real ArgoCD API calls post-MVP.
// Uses ARGOCD_URL and ARGOCD_TOKEN when real mode is enabled.

const mockApps = [
  { name: 'cnp-portal',  project: 'cnp', namespace: 'cnp-portal', status: 'Synced',    health: 'Healthy',   syncedAt: new Date(Date.now() - 86400000).toISOString(), owner: null },
  { name: 'app-alpha',   project: 'cnp', namespace: 'default',    status: 'Synced',    health: 'Healthy',   syncedAt: new Date(Date.now() - 3600000).toISOString(),  owner: 'alice' },
  { name: 'app-beta',    project: 'cnp', namespace: 'default',    status: 'OutOfSync', health: 'Degraded',  syncedAt: new Date(Date.now() - 7200000).toISOString(),  owner: 'bob' },
  { name: 'app-gamma',   project: 'cnp', namespace: 'default',    status: 'Synced',    health: 'Progressing', syncedAt: new Date(Date.now() - 600000).toISOString(), owner: 'alice' },
];

const accessRequests = [];

async function listApps(ownerFilter = null) {
  if (ownerFilter) {
    return mockApps.filter(a => a.owner === ownerFilter || a.owner === null);
  }
  return mockApps;
}

async function syncApp(appName) {
  const app = mockApps.find(a => a.name === appName);
  if (!app) throw new Error('Application not found');
  app.status = 'Synced';
  app.syncedAt = new Date().toISOString();
  return app;
}

async function requestAccess(userId, appName, reason) {
  accessRequests.push({ userId, appName, reason, requestedAt: new Date().toISOString(), approved: false });
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

module.exports = { listApps, syncApp, requestAccess, getAccessRequests, approveAccess };
