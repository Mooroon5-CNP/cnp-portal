'use strict';

// Runs only after GitOps has removed the runtime and provider resources are gone.
const { execFileSync } = require('child_process');
const path = require('path');
const axios = require('axios');
const records = require('../models/deployment_variables');
const { OpenBaoClient } = require('./openbao-client');
const { GcpVariableDelivery, secretId } = require('./openbao-delivery-gcp');
const { AzureVariableDelivery, federatedAccessToken, secretName } = require('./openbao-delivery-azure');

async function gcp(deployment, names) {
  if (!names.length) return;
  const delivery = new GcpVariableDelivery({ project: process.env.GCP_PROJECT, region: process.env.GCP_REGION,
    runtimeServiceAccount: require('./openbao-runtime').gcpRuntimeIdentity(deployment) });
  const token = await delivery.accessToken(delivery.transport);
  for (const name of names) {
    const resource = `/secrets/${secretId(deployment, name)}`;
    let existing;
    try { existing = await delivery.request(token, 'GET', resource); }
    catch (error) { if (error.status === 404) continue; throw error; }
    if (existing.labels?.cnp_app !== deployment.appName || existing.labels?.cnp_env !== deployment.environment
      || existing.labels?.cnp_owner !== 'portal_variables') throw new Error('Secret GCP existant hors du périmètre du portail.');
    try { await delivery.request(token, 'DELETE', resource); }
    catch (error) { if (error.status !== 404) throw error; }
  }
}

async function azure(deployment, names) {
  if (!names.length) return;
  const delivery = AzureVariableDelivery.fromEnvironment();
  const token = await federatedAccessToken({ tenantId: delivery.tenantId, clientId: delivery.clientId,
    tokenFile: delivery.tokenFile, transport: delivery.transport });
  const headers = { Authorization: `Bearer ${token}` };
  for (const name of names) {
    const url = `${delivery.vaultUrl}/secrets/${secretName(deployment, name)}?api-version=7.4`;
    let existing;
    try { ({ data: existing } = await axios.get(url, { headers, timeout: 10000, maxRedirects: 0 })); }
    catch (error) { if (error.response?.status === 404) continue; throw new Error('Lecture Azure Key Vault indisponible.'); }
    if (existing.tags?.cnp_app !== deployment.appName || existing.tags?.cnp_env !== deployment.environment
      || existing.tags?.cnp_owner !== 'portal_variables') throw new Error('Secret Azure existant hors du périmètre du portail.');
    try { await axios.delete(url, { headers, timeout: 10000, maxRedirects: 0 }); }
    catch (error) { if (error.response?.status !== 404) throw new Error('Suppression Azure Key Vault indisponible.'); }
  }
}

function aws(deployment, names) {
  if (!names.length) return;
  const script = path.resolve(__dirname, '../../scripts/failover/engine/openbao_cleanup_aws.py');
  try {
    execFileSync(process.env.CNP_FAILOVER_PYTHON || 'python3', [script], { input: JSON.stringify({ app: deployment.appName,
      names, region: process.env.CNP_AWS_REGION }), encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (_) { throw new Error('Suppression AWS des variables indisponible ou refusée.'); }
}

async function cleanup(deployment) {
  const record = records.get(deployment.id);
  if (!record) return;
  if (deployment.targetCluster === 'azure') await azure(deployment, record.ownedNames);
  else {
    await gcp(deployment, record.ownedNames);
    if (deployment.failoverRequested) aws(deployment, record.ownedNames);
  }
  const versions = new Map();
  for (const entry of record.history) {
    for (const [domain, version] of Object.entries(entry.versions)) {
      if (!Number.isInteger(version) || version < 1) throw new Error('Historique OpenBao invalide.');
      if (!versions.has(domain)) versions.set(domain, new Set());
      versions.get(domain).add(version);
    }
  }
  for (const [domain, entries] of versions) {
    const client = OpenBaoClient.fromEnvironment(domain);
    for (const version of entries) await client.destroyVersion(deployment.appName, deployment.environment, version);
  }
}

module.exports = { cleanup };
