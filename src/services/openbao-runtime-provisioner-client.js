'use strict';

const axios = require('axios');
const fs = require('fs');

async function call(operation, clouds, deployment, { transport = axios,
  address = process.env.CNP_OPENBAO_RUNTIME_PROVISIONER_ADDR,
  tokenFile = process.env.CNP_OPENBAO_RUNTIME_PROVISIONER_TOKEN_FILE,
  readFile = fs.readFileSync } = {}) {
  if (!clouds.includes(deployment.targetCluster)) return null;
  // Keep legacy local and deployed mappings working until promotion opts in.
  if (!address) return null;
  if (!tokenFile) throw new Error('Provisionneur des identités runtime indisponible.');
  const unconfirmed = operation === 'ensure' ? 'Identité runtime non confirmée.' : 'Suppression des identités runtime non confirmée.';
  try {
    const token = readFile(tokenFile, 'utf8').trim();
    if (!token) throw new Error('Identité du portail pour le provisionneur indisponible.');
    const { data } = await transport.post(`${address.replace(/\/$/, '')}/${operation}`, {
      appName: deployment.appName, environment: deployment.environment, targetCluster: deployment.targetCluster,
      failoverRequested: deployment.failoverRequested === true,
    }, { headers: { Authorization: `Bearer ${token}` }, timeout: 120000, maxRedirects: 0 });
    if (operation === 'release-domain') {
      if (typeof data?.released !== 'boolean') throw new Error(unconfirmed);
      return data;
    }
    if ((operation === 'ensure' ? data?.ready : data?.removed) !== true) throw new Error(unconfirmed);
    return data;
  } catch (error) {
    if ([unconfirmed, 'Identité du portail pour le provisionneur indisponible.'].includes(error.message)) throw error;
    const detail = error.response?.data?.error;
    throw new Error(typeof detail === 'string' && detail.length < 200 ? detail
      : 'Provisionnement des identités runtime indisponible. Réessayez après correction.');
  }
}

async function ensure(deployment, options) {
  await call('ensure', ['gcp', 'azure'], deployment, options);
}

// Suppression d'un environnement : GCP, compte runtime dédié et, en prod avec secours, rôle AWS de l'app ;
// Azure, coffre et identité runtime de l'app.
async function remove(deployment, options) {
  return call('remove', ['gcp', 'azure'], deployment, options);
}

// Avant la suppression d'un environnement Azure : { released } (false = réessayer plus tard). Sans provisionneur : null.
async function releaseDomain(deployment, options) {
  return call('release-domain', ['azure'], deployment, options);
}

module.exports = { ensure, remove, releaseDomain };
