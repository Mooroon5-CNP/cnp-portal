'use strict';

const axios = require('axios');
const fs = require('fs');
const { createHash } = require('crypto');
const { validate } = require('./openbao-variables');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VAULT = /^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/?$/;
const VERSION = /^[0-9a-f]{32}$/i;

function vaultUrlFor(deployment) {
  if (process.env.CNP_OPENBAO_DERIVED_IDENTITIES !== 'true'
    && !process.env.CNP_OPENBAO_RUNTIME_PROVISIONER_ADDR) return process.env.CNP_AZURE_VAULT_URL;
  const subscription = process.env.AZURE_SUBSCRIPTION_ID;
  if (!GUID.test(subscription || '') || !deployment?.appName || !['dev', 'prod'].includes(deployment.environment)) {
    throw new Error('Paramètres Azure des coffres applicatifs manquants.');
  }
  const key = `${deployment.appName}/${deployment.environment}`;
  return `https://cnp${subscription.replace(/-/g, '').slice(0, 8).toLowerCase()}${createHash('sha256').update(key).digest('hex').slice(0, 12)}.vault.azure.net`;
}

function secretName(deployment, variable) {
  const hash = createHash('sha256').update(variable).digest('hex').slice(0, 12);
  return `cnp-${deployment.appName}-${deployment.environment}-var-${hash}`;
}

async function federatedAccessToken({ tenantId, clientId, tokenFile, transport = axios,
  scope = 'https://vault.azure.net/.default' }) {
  if (!GUID.test(tenantId) || !GUID.test(clientId) || !tokenFile) throw new Error('Identité Azure du portail non configurée.');
  // Read the projected token afresh: Kubernetes rotates it independently from Entra tokens.
  const assertion = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!assertion) throw new Error('Jeton fédéré Azure du portail indisponible.');
  const form = new URLSearchParams({ client_id: clientId, scope,
    grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion });
  try {
    const { data } = await transport.post(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000, maxRedirects: 0,
    });
    if (typeof data?.access_token !== 'string' || !data.access_token) throw new Error('Token Azure absent.');
    return data.access_token;
  } catch (_) {
    throw new Error('Authentification fédérée Azure du portail indisponible.');
  }
}

class AzureVariableDelivery {
  constructor({ vaultUrl, tenantId, clientId, tokenFile, transport = axios, accessToken = federatedAccessToken,
    recoverAttempts = 15, recoverDelayMs = 2000 }) {
    if (!VAULT.test(vaultUrl) || !GUID.test(tenantId) || !GUID.test(clientId) || !tokenFile) {
      throw new Error('Configuration Azure des variables invalide.');
    }
    this.vaultUrl = vaultUrl.replace(/\/$/, '');
    this.tenantId = tenantId;
    this.clientId = clientId;
    this.tokenFile = tokenFile;
    this.transport = transport;
    this.accessToken = accessToken;
    this.recoverAttempts = recoverAttempts;
    this.recoverDelayMs = recoverDelayMs;
  }

  static fromEnvironment(deployment, dependencies = {}) {
    return new AzureVariableDelivery({ vaultUrl: vaultUrlFor(deployment),
      tenantId: process.env.CNP_AZURE_TENANT_ID, clientId: process.env.CNP_AZURE_PORTAL_CLIENT_ID,
      tokenFile: process.env.CNP_AZURE_FEDERATED_TOKEN_FILE, ...dependencies });
  }

  async recoverOwnSecret(deployment, id, options) {
    const { data: deleted } = await this.transport.get(`${this.vaultUrl}/deletedsecrets/${id}?api-version=7.4`, options);
    if (deleted?.tags?.cnp_app !== deployment.appName || deleted?.tags?.cnp_env !== deployment.environment
      || deleted?.tags?.cnp_owner !== 'portal_variables') {
      throw new Error('Secret Azure existant hors du périmètre du portail.');
    }
    await this.transport.post(`${this.vaultUrl}/deletedsecrets/${id}/recover?api-version=7.4`, null, options);
    // Recovery is asynchronous: wait until the secret is readable again before writing a new version.
    for (let attempt = 0; attempt < this.recoverAttempts; attempt += 1) {
      try { await this.transport.get(`${this.vaultUrl}/secrets/${id}?api-version=7.4`, options); return; }
      catch (error) { if (error.response?.status !== 404) throw error; }
      await new Promise(resolve => setTimeout(resolve, this.recoverDelayMs));
    }
    throw new Error('Récupération du secret Azure non confirmée.');
  }

  async deliver(deployment, values) {
    const entries = validate(values);
    if (deployment.targetCluster !== 'azure' || !['dev', 'prod'].includes(deployment.environment)) {
      throw new Error('Déploiement Azure invalide pour les variables.');
    }
    if (!entries.length) return [];
    const token = await this.accessToken({ tenantId: this.tenantId, clientId: this.clientId,
      tokenFile: this.tokenFile, transport: this.transport });
    const references = [];
    for (const [name, value] of entries) {
      const id = secretName(deployment, name);
      const url = `${this.vaultUrl}/secrets/${id}`;
      try {
        let existing;
        try {
          ({ data: existing } = await this.transport.get(`${url}?api-version=7.4`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000, maxRedirects: 0 }));
        } catch (error) { if (error.response?.status !== 404) throw error; }
        if (existing && (existing.tags?.cnp_app !== deployment.appName
          || existing.tags?.cnp_env !== deployment.environment || existing.tags?.cnp_owner !== 'portal_variables')) {
          throw new Error('Secret Azure existant hors du périmètre du portail.');
        }
        const body = { value, tags: { cnp_app: deployment.appName, cnp_env: deployment.environment, cnp_owner: 'portal_variables' } };
        const options = { headers: { Authorization: `Bearer ${token}` }, timeout: 10000, maxRedirects: 0 };
        let data;
        try {
          ({ data } = await this.transport.put(`${url}?api-version=7.4`, body, options));
        } catch (error) {
          // A re-created application finds its previous secret soft-deleted (vault soft delete, 7 days):
          // Key Vault answers 409 ObjectIsDeletedButRecoverable. Recover our own secret, then write the new version.
          // Real Key Vault shape (24/11/2026): { error: { code: 'Conflict', innererror: { code: 'ObjectIsDeletedButRecoverable' } } }.
          const conflict = error.response?.data?.error;
          if (error.response?.status !== 409 || ![conflict?.code, conflict?.innererror?.code].includes('ObjectIsDeletedButRecoverable')) throw error;
          await this.recoverOwnSecret(deployment, id, options);
          ({ data } = await this.transport.put(`${url}?api-version=7.4`, body, options));
        }
        const expected = `${this.vaultUrl}/secrets/${id}/`;
        if (typeof data?.id !== 'string' || !data.id.startsWith(expected) || !VERSION.test(data.id.slice(expected.length))) {
          throw new Error('Version Azure Key Vault invalide.');
        }
        references.push({ name, secretName: id, keyVaultSecretId: data.id });
      } catch (error) {
        if (['Version Azure Key Vault invalide.', 'Secret Azure existant hors du périmètre du portail.',
          'Récupération du secret Azure non confirmée.'].includes(error.message)) throw error;
        const code = error.response?.status;
        throw new Error(`Azure Key Vault indisponible ou accès refusé${Number.isInteger(code) ? ` (HTTP ${code})` : ''}.`);
      }
    }
    return references;
  }
}

module.exports = { AzureVariableDelivery, federatedAccessToken, secretName, vaultUrlFor };
