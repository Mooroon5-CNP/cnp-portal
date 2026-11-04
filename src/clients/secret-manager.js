'use strict';
const axios = require('axios');
const { createHash } = require('crypto');
const auth = require('./google-access');
const { config } = require('../config/env');

// IAM can briefly lag a newly created service account. Retry only conflicts or
// explicit propagation errors; never retry denied access as if it were readiness.
async function updatePolicy(read, write, patch, allowNotFound = false) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const { data: policy } = await read();
      policy.bindings ||= []; patch(policy);
      await write(policy); return;
    } catch (error) {
      const status = error.response?.status;
      const pendingIdentity = status === 400 && /service account.*(does not exist|not found)/i.test(error.response?.data?.error?.message || '');
      if (attempt === 5 || !(status === 409 || pendingIdentity || (allowNotFound && status === 404))) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** attempt, 8000)));
    }
  }
}
function runtimeAccount(dep) {
  const id = `cnp-${createHash('sha256').update(dep.id).digest('hex').slice(0, 24)}`;
  return `${id}@${config.gcp.project}.iam.gserviceaccount.com`;
}
async function prepare(dep) {
  const account = runtimeAccount(dep);
  const provisioner = process.env.GCP_CROSSPLANE_SERVICE_ACCOUNT || `crossplane-gcp-sa@${config.gcp.project}.iam.gserviceaccount.com`;
  if (!/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(provisioner)) throw new Error('Identité Crossplane non configurée.');
  try {
    const headers = await auth.headers();
    const root = `https://iam.googleapis.com/v1/projects/${config.gcp.project}/serviceAccounts`;
    const request = (method, url, data) => axios.request({ method, url, data, headers, timeout: 10000 });
    let created = false;
    try { await request('GET', `${root}/${account}`); }
    catch (error) {
      if (error.response?.status !== 404) throw error;
      created = true;
      await request('POST', root, { accountId: account.split('@')[0], serviceAccount: { displayName: `CNP runtime ${dep.appName} ${dep.environment}` } });
    }
    await updatePolicy(
      () => request('POST', `${root}/${account}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } }),
      policy => request('POST', `${root}/${account}:setIamPolicy`, { policy }),
      policy => {
        let binding = policy.bindings.find(item => item.role === 'roles/iam.serviceAccountUser' && !item.condition);
        if (!binding) { binding = { role: 'roles/iam.serviceAccountUser', members: [] }; policy.bindings.push(binding); }
        binding.members = [...new Set([...(binding.members || []), `serviceAccount:${provisioner}`])];
      }, created,
    );
  } catch (_) { throw new Error('Création de l’identité Cloud Run impossible. Vérifiez les droits IAM du portail et l’identité Crossplane.'); }
}

async function store(dep, key, value) {
  // An empty environment value contains no secret payload; do not rely on the
  // secret provider accepting a zero-byte version. No non-empty plaintext is returned.
  if (value === '') return { name: key, value: '' };
  const project = config.gcp.project;
  const account = runtimeAccount(dep);
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project || '') || !/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(account || '')) {
    throw new Error('Projet GCP ou compte runtime Cloud Run non configuré.');
  }
  const hash = createHash('sha256').update(`${dep.id}/${key}`).digest('hex').slice(0, 40);
  const id = `cnp-env-${hash}`;
  const resource = `projects/${project}/secrets/${id}`;
  try {
    const headers = await auth.headers();
    const request = (method, name, data, params) => axios.request({ method, url: `https://secretmanager.googleapis.com/v1/${name}`, data, params, headers, timeout: 10000 });
    try {
      const { data } = await request('GET', resource);
      if (data.labels?.['cnp-deployment'] !== dep.id) throw new Error('Secret ownership mismatch');
    } catch (error) {
      if (error.response?.status !== 404) throw error;
      await request('POST', `projects/${project}/secrets`, { replication: { automatic: {} }, labels: { 'cnp-deployment': dep.id } }, { secretId: id });
    }
    // Preserve unrelated grants and use etag to avoid overwriting concurrent IAM changes.
    await updatePolicy(
      () => request('GET', `${resource}:getIamPolicy`, undefined, { 'options.requestedPolicyVersion': 3 }),
      policy => request('POST', `${resource}:setIamPolicy`, { policy }),
      policy => {
        let binding = policy.bindings.find(item => item.role === 'roles/secretmanager.secretAccessor' && !item.condition);
        if (!binding) { binding = { role: 'roles/secretmanager.secretAccessor', members: [] }; policy.bindings.push(binding); }
        binding.members = [...new Set([...(binding.members || []), `serviceAccount:${account}`])];
      },
    );
    const { data } = await request('POST', `${resource}:addVersion`, { payload: { data: Buffer.from(value).toString('base64') } });
    const version = data.name?.split('/').pop();
    if (!/^\d+$/.test(version || '')) throw new Error('Invalid secret version');
    return { name: key, valueSource: { secretKeyRef: { secret: id, version } } };
  } catch (_) {
    // Axios errors contain request data and tokens; never propagate or log them.
    throw new Error('Stockage des variables Cloud Run impossible. Vérifiez Secret Manager et les droits du compte de service du portail.');
  }
}
module.exports = { store, prepare, runtimeAccount };

const REQUIRED_PERMISSIONS = [
  'serviceusage.services.get', 'resourcemanager.projects.get',
  'secretmanager.secrets.create', 'secretmanager.secrets.get', 'secretmanager.secrets.getIamPolicy',
  'secretmanager.secrets.setIamPolicy', 'secretmanager.versions.add',
  'iam.serviceAccounts.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy',
];
async function capability() {
  try {
    if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(config.gcp.project || '')) throw new Error('project missing');
    const identity = await auth.identity();
    if (identity.email === config.gcp.cloudRunSa || (identity.kind === 'authorized_user' && process.env.NODE_ENV === 'production')) {
      return { available: false, code: 'PLATFORM_DEDICATED_IDENTITY_REQUIRED', message: 'La plateforme doit utiliser une identité dédiée, distincte du compte partagé des applications.' };
    }
    const headers = await auth.headers();
    const { data } = await axios.post(`https://cloudresourcemanager.googleapis.com/v1/projects/${config.gcp.project}:testIamPermissions`,
      { permissions: REQUIRED_PERMISSIONS }, { headers, timeout: 10000 });
    const missing = REQUIRED_PERMISSIONS.filter(permission => !data.permissions?.includes(permission));
    if (missing.length) return { available: false, code: 'PLATFORM_PERMISSIONS_MISSING', message: 'La gestion des variables doit être activée par un administrateur de la plateforme.', missing };
    const project = await axios.get(`https://cloudresourcemanager.googleapis.com/v1/projects/${config.gcp.project}`, { headers, timeout: 10000 });
    const projectNumber = String(project.data.projectNumber || '');
    if (!/^\d+$/.test(projectNumber)) throw new Error('Project number unavailable');
    for (const service of ['secretmanager.googleapis.com', 'iam.googleapis.com']) {
      const result = await axios.get(`https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${service}`, { headers, timeout: 10000 });
      if (result.data.state !== 'ENABLED') return { available: false, code: 'PLATFORM_APIS_DISABLED', message: 'Un administrateur doit activer les API de stockage sécurisé de la plateforme.' };
    }
    return { available: true, code: 'READY', identity: identity.email, message: 'Identité, permissions et API de la plateforme vérifiées.' };
  } catch (_) {
    return { available: false, code: 'PLATFORM_IDENTITY_UNAVAILABLE', message: 'Le stockage sécurisé est indisponible. Un administrateur doit vérifier l’identité GCP et les API de la plateforme.' };
  }
}
module.exports.capability = capability;
module.exports.REQUIRED_PERMISSIONS = REQUIRED_PERMISSIONS;
