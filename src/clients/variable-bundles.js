'use strict';
const { createHash, randomUUID } = require('crypto');
const auth = require('./google-access');
const identity = require('./secret-manager');
const { config } = require('../config/env');
const protocol = require('../../scripts/runtime/variables.cjs');
const { provisionError } = require('../../scripts/runtime/provider-error.cjs');
const GCS_PERMISSIONS = ['storage.buckets.create', 'storage.buckets.get', 'storage.buckets.getIamPolicy', 'storage.buckets.setIamPolicy', 'storage.objects.create', 'storage.objects.get', 'iam.serviceAccounts.create', 'iam.serviceAccounts.get', 'iam.serviceAccounts.getIamPolicy', 'iam.serviceAccounts.setIamPolicy'];
function provider() { return process.env.CNP_VARIABLES_PROVIDER || 'secret-manager'; }
function client(credentials = auth) { return protocol.createClient({ getAccess: credentials.token, req: protocol.request, getJWT: protocol.googleJWT }); }
function bucket(dep) { return `cnp-vars-${createHash('sha256').update(`${config.gcp.project}/${dep.id}/${dep.environment}`).digest('hex').slice(0, 32)}`; }
function target(dep) { return { applicationId: dep.id, environment: dep.environment }; }
async function capability() {
  try {
    if (!['gcs', 'openbao'].includes(provider())) throw new Error('provider');
    const principal = await auth.identity();
    if (principal.email === config.gcp.cloudRunSa || (principal.kind === 'authorized_user' && process.env.NODE_ENV === 'production')) throw new Error('dedicated identity');
    if (provider() === 'openbao') {
      const settings = protocol.baoSettings(process.env);
      const health = await protocol.request(`${settings.origin}/v1/sys/health?standbyok=true`);
      if (!health.initialized || health.sealed) throw new Error('sealed');
      await client().bao(process.env.CNP_OPENBAO_CONTROL_ROLE || 'cnp-control');
    } else {
      const headers = await auth.headers();
      const required = GCS_PERMISSIONS;
      const result = await protocol.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${config.gcp.project}:testIamPermissions`, { method: 'POST', headers, body: { permissions: required } });
      if (required.some(permission => !result.permissions?.includes(permission))) throw new Error('permissions');
    }
    return { available: true, code: 'READY', message: `Identité ${provider()} disponible ; les droits du scope seront vérifiés lors de la préparation.` };
  } catch (_) { return { available: false, code: 'VARIABLE_STORE_UNAVAILABLE', message: `Stockage ${provider()} indisponible : vérifier l’identité dédiée du portail, les droits et la connexion au fournisseur.` }; }
}
async function prepare(dep, credentials = auth) {
  if (dep.environment === 'prod' && process.env.CNP_VARIABLES_PRODUCTION_ENABLED !== 'true') throw new Error('Les bundles de production seront activés après validation du pilote, du rollback et de l’approbation.');
  if (dep.githubRepoUrl) {
    const source = require('../services/github').parseRepoUrl(dep.githubRepoUrl);
    if (!source) throw new Error('Dépôt invalide.');
    const api = await require('./github').getInstallationOctokit();
    let file;
    try { file = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...source, path: 'Dockerfile', ref: dep.environment === 'prod' ? 'prod' : 'main' }); }
    catch (_) { throw new Error('Dockerfile inaccessible pour vérifier le chargeur.'); }
    const dockerfile = Buffer.from(file.data.content, 'base64').toString('utf8');
    const finalStage = dockerfile.slice([...dockerfile.matchAll(/^FROM .+$/gm)].at(-1)?.index || 0);
    if (!/^LABEL\s+io\.cnp\.variables-contract=["']?1["']?(?:\s|$)/m.test(finalStage)) throw new Error('Installez le chargeur CNP dans ce Dockerfile avant d’ajouter des variables.');
  }
  await identity.prepare(dep, credentials);
  const headers = await credentials.headers();
  const call = async (operation, url, options) => {
    try { return await protocol.request(url, { timeout: 15000, ...options }); }
    catch (error) { throw provisionError(operation, error, 'Préparation du stockage impossible.'); }
  };
  if (provider() === 'gcs') {
    const name = bucket(dep); const base = `https://storage.googleapis.com/storage/v1/b/${name}`;
    let metadata;
    try { metadata = await call('storage.buckets.get', base, { headers }); }
    catch (error) {
      if (error.status !== 404) throw error;
      metadata = await call('storage.buckets.create', `https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(config.gcp.project)}`, { method: 'POST', headers, body: {
        name, location: config.gcp.region, labels: { 'cnp-deployment': dep.id },
        iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced' },
      } });
    }
    if (metadata.labels?.['cnp-deployment'] !== dep.id || metadata.iamConfiguration?.publicAccessPrevention !== 'enforced' || metadata.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true) throw new Error('Le bucket ne respecte pas le contrat privé.');
    const policy = await call('storage.buckets.getIamPolicy', `${base}/iam?optionsRequestedPolicyVersion=3`, { headers });
    if (policy.bindings?.some(binding => binding.members?.some(member => ['allUsers', 'allAuthenticatedUsers'].includes(member)))) throw new Error('Un accès public au bucket est interdit.');
    policy.bindings ||= [];
    const member = `serviceAccount:${identity.runtimeAccount(dep)}`;
    if (!policy.bindings.some(binding => binding.role === 'roles/storage.objectViewer' && !binding.condition && binding.members?.includes(member))) policy.bindings.push({ role: 'roles/storage.objectViewer', members: [member] });
    await call('storage.buckets.setIamPolicy', `${base}/iam`, { method: 'PUT', headers, body: policy });
  } else {
    const account = await protocol.request(`https://iam.googleapis.com/v1/projects/${config.gcp.project}/serviceAccounts/${identity.runtimeAccount(dep)}`, { headers });
    if (!/^\d+$/.test(account.uniqueId || '')) throw new Error('Identité runtime Google invalide.');
    const role = `cnp-${dep.id}-${dep.environment}`; const path = `cnp-runtime/data/apps/${dep.id}/${dep.environment}/bundles/*`;
    const bao = await client(credentials).bao(process.env.CNP_OPENBAO_CONTROL_ROLE || 'cnp-control');
    await protocol.request(`${bao.origin}/v1/sys/policies/acl/${role}`, { method: 'PUT', headers: bao.headers, body: { policy: `path "${path}" { capabilities = ["read"] }` } });
    const settings = protocol.baoSettings(process.env);
    await protocol.request(`${bao.origin}/v1/auth/jwt/role/${role}`, { method: 'POST', headers: bao.headers, body: {
      role_type: 'jwt', user_claim: 'sub', bound_subject: account.uniqueId, bound_audiences: [settings.audience],
      token_policies: [role], token_no_default_policy: true, token_ttl: '5m', token_explicit_max_ttl: '5m',
    } });
  }
}
async function write(dep, values, credentials = auth) {
  const bundleId = randomUUID();
  try {
    const reference = await client(credentials).writeBundle(target(dep), values, provider(), { bundleId, bucket: bucket(dep) });
    return { reference, names: Object.keys(values).sort() };
  } catch (error) { throw provisionError(provider() === 'gcs' ? 'storage.objects.create' : 'openbao.kv.write', error, 'Enregistrement du bundle impossible. Aucune nouvelle configuration publiée.'); }
}
async function read(bundle) {
  try { return await client().readBundle(bundle.reference, true); }
  catch (_) { throw new Error('Lecture de la configuration précédente impossible ; aucune valeur remplacée.'); }
}
module.exports = { GCS_PERMISSIONS, provider, bucket, capability, prepare, write, read, runtimeAccount: identity.runtimeAccount };
