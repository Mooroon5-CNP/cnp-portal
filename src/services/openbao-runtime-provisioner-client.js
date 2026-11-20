'use strict';

const axios = require('axios');
const fs = require('fs');

async function ensure(deployment, { transport = axios,
  address = process.env.CNP_OPENBAO_RUNTIME_PROVISIONER_ADDR,
  tokenFile = process.env.CNP_OPENBAO_RUNTIME_PROVISIONER_TOKEN_FILE,
  readFile = fs.readFileSync } = {}) {
  if (!['gcp', 'azure'].includes(deployment.targetCluster)) return;
  // Keep legacy local and deployed mappings working until promotion opts in.
  if (!address) return;
  if (!tokenFile) throw new Error('Provisionneur des identités runtime indisponible.');
  try {
    const token = readFile(tokenFile, 'utf8').trim();
    if (!token) throw new Error('Identité du portail pour le provisionneur indisponible.');
    const { data } = await transport.post(`${address.replace(/\/$/, '')}/ensure`, {
      appName: deployment.appName, environment: deployment.environment, targetCluster: deployment.targetCluster,
      failoverRequested: deployment.failoverRequested === true,
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 120000, maxRedirects: 0 });
    if (data?.ready !== true) throw new Error('Identité runtime non confirmée.');
  } catch (error) {
    if (['Identité runtime non confirmée.', 'Identité du portail pour le provisionneur indisponible.'].includes(error.message)) throw error;
    const detail = error.response?.data?.error;
    throw new Error(typeof detail === 'string' && detail.length < 200 ? detail
      : 'Provisionnement des identités runtime indisponible. Réessayez après correction.');
  }
}

module.exports = { ensure };
