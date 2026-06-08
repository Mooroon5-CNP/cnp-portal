'use strict';

const client = require('../clients/argocd');

// Portal-level access request workflow (not an ArgoCD native feature)
const accessRequests = [];

async function listApps() {
  try {
    const apps = await client.listApplications();
    return apps.map(app => ({
      name:      app.name,
      project:   app.project,
      namespace: app.namespace,
      status:    app.sync    || 'Unknown',
      health:    app.health  || 'Unknown',
      syncedAt:  app.lastDeployedAt || new Date().toISOString(),
      revision:  app.revision,
    }));
  } catch (err) {
    console.error('[argocd] listApps error:', err.message);
    return [];
  }
}

async function syncApp(appName) {
  return client.syncApplication(appName);
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
