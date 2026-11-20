'use strict';

const axios = require('axios');
const { createHash } = require('crypto');
const { googleAccessToken } = require('./openbao-delivery-gcp');

const PROJECT = /^[a-z][a-z0-9-]{4,62}$/;
const APP = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const EMAIL = /^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

function accountFor(deployment, project) {
  if (!PROJECT.test(project || '') || !APP.test(deployment?.appName || '')
    || !['dev', 'prod'].includes(deployment.environment)) throw new Error('Identité GCP runtime invalide.');
  const key = `${deployment.appName}/${deployment.environment}`;
  const id = `cnp-${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
  return { key, id, email: `${id}@${project}.iam.gserviceaccount.com`,
    displayName: `CNP OpenBao runtime ${key}` };
}

async function request(transport, token, method, url, data) {
  try {
    const response = await transport.request({ method, url, data,
      headers: { Authorization: `Bearer ${token}` }, timeout: 10000, maxRedirects: 0 });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    throw Object.assign(new Error(`Provisionnement GCP indisponible ou accès refusé${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`),
      { status: Number.isInteger(status) ? status : undefined });
  }
}

async function addMember(transport, token, readMethod, readUrl, writeUrl, role, member) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const policy = await request(transport, token, readMethod, readUrl,
      readMethod === 'POST' ? { options: { requestedPolicyVersion: 3 } } : undefined);
    const binding = (policy.bindings || []).find(item => item.role === role && !item.condition);
    if (binding?.members?.includes(member)) return;
    const bindings = binding
      ? policy.bindings.map(item => item === binding ? { ...item, members: [...(item.members || []), member] } : item)
      : [...(policy.bindings || []), { role, members: [member] }];
    try {
      await request(transport, token, 'POST', writeUrl, { policy: { ...policy, bindings } });
      return;
    } catch (error) { if (error.status !== 409 || attempt === 2) throw error; }
  }
}

async function ensureGcpIdentity(deployment, { project = process.env.GCP_PROJECT,
  crossplaneServiceAccount = process.env.CNP_GCP_CROSSPLANE_SA,
  transport = axios, accessToken = googleAccessToken } = {}) {
  const account = accountFor(deployment, project);
  if (!EMAIL.test(crossplaneServiceAccount || '') || crossplaneServiceAccount === account.email) {
    throw new Error('Identité GCP Crossplane manquante ou invalide.');
  }
  const token = await accessToken(transport);
  const base = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`;
  const resource = `${base}/${account.email}`;
  let existing;
  try { existing = await request(transport, token, 'GET', resource); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!existing) {
    try {
      await request(transport, token, 'POST', base, { accountId: account.id,
        serviceAccount: { displayName: account.displayName } });
    } catch (error) { if (error.status !== 409) throw error; }
    existing = await request(transport, token, 'GET', resource);
  }
  if (existing.email !== account.email || existing.displayName !== account.displayName) {
    throw new Error('Compte GCP runtime existant hors du périmètre attendu.');
  }
  await addMember(transport, token, 'GET', `${resource}:getIamPolicy?options.requestedPolicyVersion=3`, `${resource}:setIamPolicy`,
    'roles/iam.serviceAccountUser', `serviceAccount:${crossplaneServiceAccount}`);
  const projectBase = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;
  await addMember(transport, token, 'POST', `${projectBase}:getIamPolicy`, `${projectBase}:setIamPolicy`,
    'roles/cloudsql.client', `serviceAccount:${account.email}`);
  return account.email;
}

module.exports = { accountFor, ensureGcpIdentity };
