'use strict';

const axios = require('axios');
const https = require('https');
const { config } = require('../config/env');

let sessionPromise;

async function makeClient() {
  if (!config.argocd.serverUrl || (!config.argocd.token && !(config.argocd.username && config.argocd.password))) {
    throw new Error('ArgoCD credentials not configured (URL and token, or username/password)');
  }

  const transport = {
    baseURL: `${config.argocd.serverUrl.replace(/\/$/, '')}/api/v1`,
    timeout: 10000,
    httpsAgent: config.argocd.insecure
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined,
  };
  const client = axios.create(transport);
  async function authenticate() {
    if (!sessionPromise) {
      sessionPromise = client.post('/session', {
        username: config.argocd.username, password: config.argocd.password,
      }).then(({ data }) => {
        if (!data.token) throw new Error('ArgoCD returned no session token');
        return data.token;
      }).catch(err => { sessionPromise = undefined; throw err; });
    }
    return sessionPromise;
  }
  client.defaults.headers.common.Authorization = `Bearer ${config.argocd.token || await authenticate()}`;
  // Session credentials survive an expiring session without restarting the portal.
  client.interceptors.response.use(response => response, async err => {
    const request = err.config;
    if (err.response?.status !== 401 || config.argocd.token || !request || request._argoRetried || request.url === '/session') throw err;
    request._argoRetried = true;
    sessionPromise = undefined;
    request.headers.Authorization = `Bearer ${await authenticate()}`;
    return client.request(request);
  });
  return client;
}

function handleError(err, context) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    throw new Error(`ArgoCD unreachable at ${config.argocd.serverUrl}: ${err.message}`);
  }
  if (err.response) {
    const status = err.response.status;
    if (status === 401) throw new Error('ArgoCD authentication failed. Check the configured token or username/password.');
    if (status === 404) throw new Error(`ArgoCD resource not found: ${context}`);
    throw new Error(`ArgoCD API error (${status}) on ${context}: ${err.response.data?.message || err.message}`);
  }
  if (err.code === 'ECONNABORTED') throw new Error(`ArgoCD request timed out: ${context}`);
  throw new Error(`ArgoCD request failed (${context}): ${err.message}`);
}

async function listApplications() {
  const client = await makeClient();
  try {
    const { data } = await client.get('/applications');
    return (data.items || []).map(app => ({
      name: app.metadata.name,
      project: app.spec.project,
      namespace: app.spec.destination.namespace,
      health: app.status?.health?.status,
      sync: app.status?.sync?.status,
      lastDeployedAt: app.status?.operationState?.finishedAt,
      revision: app.status?.sync?.revision,
    }));
  } catch (err) {
    handleError(err, 'listApplications');
  }
}

async function getApplicationStatus(appName) {
  const client = await makeClient();
  try {
    const { data } = await client.get(`/applications/${encodeURIComponent(appName)}`);
    return {
      health: data.status?.health?.status,
      sync: data.status?.sync?.status,
      lastDeployedAt: data.status?.operationState?.finishedAt,
      revision: data.status?.sync?.revision,
    };
  } catch (err) {
    handleError(err, `getApplicationStatus(${appName})`);
  }
}

// Read-only raw status for the MCP contract adapter.
async function getApplicationDetails(appName) {
  const client = await makeClient();
  try { return (await client.get(`/applications/${encodeURIComponent(appName)}`)).data; }
  catch (err) { handleError(err, `getApplicationDetails(${appName})`); }
}

// Préflight de l'onboarding : projets provisionnés par l'opérateur.
async function getProject(name) {
  const client = await makeClient();
  try { return (await client.get(`/projects/${encodeURIComponent(name)}`)).data; }
  catch (err) { handleError(err, `getProject(${name})`); }
}

async function getApplicationIfExists(name) {
  const client = await makeClient();
  try { return (await client.get(`/applications/${encodeURIComponent(name)}`)).data; }
  catch (err) {
    if (err.response?.status === 404) return null;
    handleError(err, `getApplicationIfExists(${name})`);
  }
}

async function syncApplication(appName) {
  const client = await makeClient();
  try {
    const { data } = await client.post(`/applications/${encodeURIComponent(appName)}/sync`, {});
    return {
      name: data.metadata?.name,
      sync: data.status?.sync?.status,
    };
  } catch (err) {
    handleError(err, `syncApplication(${appName})`);
  }
}

async function checkConnectivity() {
  const client = await makeClient();
  try {
    await client.get('/applications', { params: { limit: 1 } });
  } catch (err) {
    handleError(err, 'checkConnectivity');
  }
}

// Delete an ArgoCD Application via the ArgoCD REST API.
// cascade=true tells ArgoCD to prune all managed K8s resources first
// (including Crossplane CRs, which triggers GCP resource deletion).
async function deleteApplication(name, { cascade = true } = {}) {
  const client = await makeClient();
  try {
    await client.delete(`/applications/${encodeURIComponent(name)}`, {
      params: { cascade, propagationPolicy: 'foreground' },
    });
  } catch (err) {
    if (err.response && err.response.status === 404) return;
    handleError(err, `deleteApplication(${name})`);
  }
}

// Delete an ArgoCD ApplicationSet via the ArgoCD REST API.
async function deleteApplicationSet(name) {
  const client = await makeClient();
  try {
    await client.delete(`/applicationsets/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.response && err.response.status === 404) return;
    handleError(err, `deleteApplicationSet(${name})`);
  }
}

module.exports = { getApplicationDetails, getProject, getApplicationIfExists, listApplications, getApplicationStatus, syncApplication, checkConnectivity, deleteApplication, deleteApplicationSet };
