'use strict';

const axios = require('axios');
const https = require('https');
const { config } = require('../config/env');

function makeClient() {
  if (!config.argocd.serverUrl || !config.argocd.token) {
    throw new Error('ArgoCD credentials not configured (ARGOCD_SERVER_URL, ARGOCD_TOKEN)');
  }

  return axios.create({
    baseURL: `${config.argocd.serverUrl}/api/v1`,
    timeout: 10000,
    headers: { Authorization: `Bearer ${config.argocd.token}` },
    httpsAgent: config.argocd.insecure
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined,
  });
}

function handleError(err, context) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    throw new Error(`ArgoCD unreachable at ${config.argocd.serverUrl}: ${err.message}`);
  }
  if (err.response) {
    const status = err.response.status;
    if (status === 401) throw new Error('ArgoCD authentication failed. Check ARGOCD_TOKEN.');
    if (status === 404) throw new Error(`ArgoCD resource not found: ${context}`);
    throw new Error(`ArgoCD API error (${status}) on ${context}: ${err.response.data?.message || err.message}`);
  }
  if (err.code === 'ECONNABORTED') throw new Error(`ArgoCD request timed out: ${context}`);
  throw new Error(`ArgoCD request failed (${context}): ${err.message}`);
}

async function listApplications() {
  const client = makeClient();
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
  const client = makeClient();
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

async function syncApplication(appName) {
  const client = makeClient();
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
  const client = makeClient();
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
  const client = makeClient();
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
  const client = makeClient();
  try {
    await client.delete(`/applicationsets/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.response && err.response.status === 404) return;
    handleError(err, `deleteApplicationSet(${name})`);
  }
}

module.exports = { listApplications, getApplicationStatus, syncApplication, checkConnectivity, deleteApplication, deleteApplicationSet };
