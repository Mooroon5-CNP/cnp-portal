'use strict';

const axios = require('axios');
const tokenStore = require('../models/tokenStore');

const GITLAB_BASE = `${process.env.GITLAB_HOST || 'https://gitlab.cri.epita.fr'}/api/v4`;

async function apiCall(userId, method, path, data = null) {
  const tokens = tokenStore.get(userId);
  if (!tokens) throw new Error('No GitLab token for user');

  const response = await axios({
    method,
    url: `${GITLAB_BASE}${path}`,
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
    data,
  });
  return response.data;
}

async function getUser(accessToken) {
  const response = await axios.get(`${GITLAB_BASE}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return response.data;
}

async function getProjects(userId) {
  return apiCall(userId, 'get', '/projects?membership=true&per_page=50&order_by=last_activity_at');
}

async function getPipelines(userId, projectId) {
  return apiCall(userId, 'get', `/projects/${projectId}/pipelines?per_page=20`);
}

async function triggerPipeline(userId, projectId, ref = 'main') {
  return apiCall(userId, 'post', `/projects/${projectId}/pipeline`, { ref });
}

async function getPipelineLogs(userId, projectId, jobId) {
  return apiCall(userId, 'get', `/projects/${projectId}/jobs/${jobId}/trace`);
}

module.exports = { getUser, getProjects, getPipelines, triggerPipeline, getPipelineLogs };
