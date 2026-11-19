'use strict';

const axios = require('axios');
const { createHash } = require('crypto');
const { validate } = require('./openbao-variables');

const PROJECT = /^[a-z][a-z0-9-]{4,62}$/;
const REGION = /^[a-z]+-[a-z0-9]+[0-9]$/;
const EMAIL = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

async function googleAccessToken(transport = axios) {
  const { data } = await transport.get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
    headers: { 'Metadata-Flavor': 'Google' }, timeout: 5000,
  });
  if (typeof data?.access_token !== 'string' || !data.access_token) throw new Error('Identité Google du portail indisponible.');
  return data.access_token;
}

function secretId(deployment, variable) {
  const hash = createHash('sha256').update(variable).digest('hex').slice(0, 12);
  return `cnp-${deployment.appName}-${deployment.environment}-var-${hash}`;
}

class GcpVariableDelivery {
  constructor({ project, region, runtimeServiceAccount, transport = axios, accessToken = googleAccessToken }) {
    if (!PROJECT.test(project) || !REGION.test(region)
      || (runtimeServiceAccount !== undefined && !EMAIL.test(runtimeServiceAccount))) {
      throw new Error('Configuration GCP des variables invalide.');
    }
    this.project = project;
    this.region = region;
    this.runtimeServiceAccount = runtimeServiceAccount;
    this.transport = transport;
    this.accessToken = accessToken;
  }

  async request(token, method, suffix, data, params) {
    try {
      const response = await this.transport.request({ method,
        url: `https://secretmanager.googleapis.com/v1/projects/${this.project}${suffix}`,
        headers: { Authorization: `Bearer ${token}` }, data, params, timeout: 10000, maxRedirects: 0 });
      return response.data;
    } catch (error) {
      const code = error.response?.status;
      throw Object.assign(new Error(`Secret Manager GCP indisponible ou accès refusé${Number.isInteger(code) ? ` (HTTP ${code})` : ''}.`),
        { status: Number.isInteger(code) ? code : undefined });
    }
  }

  async ensureSecret(token, deployment, name) {
    if (!this.runtimeServiceAccount) throw new Error('Compte GCP runtime dédié manquant.');
    const id = secretId(deployment, name);
    const resource = `/secrets/${id}`;
    let existing;
    try { existing = await this.request(token, 'GET', resource); }
    catch (error) { if (error.status !== 404) throw error; }
    if (!existing) {
      try {
        await this.request(token, 'POST', '/secrets', { labels: { cnp_app: deployment.appName,
          cnp_env: deployment.environment, cnp_owner: 'portal_variables' },
        replication: { userManaged: { replicas: [{ location: this.region }] } } }, { secretId: id });
      } catch (error) { if (error.status !== 409) throw error; }
      existing = await this.request(token, 'GET', resource);
    }
    if (existing.labels?.cnp_app !== deployment.appName || existing.labels?.cnp_env !== deployment.environment
      || existing.labels?.cnp_owner !== 'portal_variables') throw new Error('Secret GCP existant hors du périmètre du portail.');
    const policy = await this.request(token, 'GET', `${resource}:getIamPolicy`);
    const member = `serviceAccount:${this.runtimeServiceAccount}`;
    const bindings = policy.bindings || [];
    const accessor = bindings.find(binding => binding.role === 'roles/secretmanager.secretAccessor' && !binding.condition);
    if (!accessor?.members?.includes(member)) {
      const updated = accessor ? bindings.map(binding => binding === accessor
        ? { ...binding, members: [...(binding.members || []), member] } : binding)
        : [...bindings, { role: 'roles/secretmanager.secretAccessor', members: [member] }];
      await this.request(token, 'POST', `${resource}:setIamPolicy`, { policy: { ...policy, bindings: updated } });
    }
    return id;
  }

  async deliver(deployment, values) {
    const entries = validate(values);
    if (deployment.targetCluster !== 'gcp' || !['dev', 'prod'].includes(deployment.environment)) {
      throw new Error('Déploiement GCP invalide pour les variables.');
    }
    if (!entries.length) return [];
    if (!this.runtimeServiceAccount) throw new Error('Compte GCP runtime dédié manquant.');
    const token = await this.accessToken(this.transport);
    const references = [];
    for (const [name, value] of entries) {
      const id = await this.ensureSecret(token, deployment, name);
      const result = await this.request(token, 'POST', `/secrets/${id}:addVersion`,
        { payload: { data: Buffer.from(value, 'utf8').toString('base64') } });
      const version = result.name?.match(new RegExp(`^projects/${this.project}/secrets/${id}/versions/([1-9][0-9]*)$`))?.[1];
      if (!version) throw new Error('Version du secret GCP invalide.');
      references.push({ name, valueSource: { secretKeyRef: { secret: id, version } } });
    }
    return references;
  }
}

module.exports = { GcpVariableDelivery, googleAccessToken, secretId };
