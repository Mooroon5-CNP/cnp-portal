'use strict';

// A deletion spans several GitOps reconciliations. Persist its inventory before
// withdrawing Git files, and never forget the deployment until deletion is observed.
const db = require('../models/db');
const yaml = require('js-yaml');
const github = require('../clients/github');
const kubernetes = require('../clients/kubernetes');
const deployments = require('../models/deployment');
const releases = require('../models/deployment_release');
const { config } = require('../config/env');
const filenames = ['cloudrun-claim.yaml', 'cloudrun-iam.yaml', 'application-network.yaml', 'gcs-bucket.yaml', 'cloudsql.yaml'];

function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS environment_deletions (
    deployment_id TEXT PRIMARY KEY, requested_by TEXT NOT NULL, destroy_data INTEGER NOT NULL,
    step TEXT NOT NULL DEFAULT 'inventory', plan TEXT, state TEXT NOT NULL DEFAULT 'running', message TEXT,
    started_at TEXT NOT NULL, updated_at TEXT NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0)`);
}
function get(id) {
  schema();
  const row = db.prepare('SELECT * FROM environment_deletions WHERE deployment_id=?').get(id);
  return row ? { ...row, plan: row.plan ? JSON.parse(row.plan) : null } : null;
}
function start(dep, user, { destroyData = false } = {}) {
  if (!user?.id || user.role !== 'manager') throw new Error('Validation manager requise.');
  if (!['dev', 'prod'].includes(dep.environment)) throw new Error('Suppression par environnement requise.');
  if (dep.persistentStorage && !destroyData) throw new Error('Confirmez la suppression définitive des données de cet environnement.');
  schema();
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`INSERT INTO environment_deletions (deployment_id,requested_by,destroy_data,started_at,updated_at)
      VALUES (?,?,?,?,?) ON CONFLICT(deployment_id) DO UPDATE SET state='running',message=NULL,started_at=excluded.started_at,updated_at=excluded.updated_at`)
      .run(dep.id, user.id, destroyData ? 1 : 0, now, now);
    deployments.updateOnboardingStatus(dep.id, 'deleting');
  })();
  return get(dep.id);
}
function save(id, values) {
  const entries = Object.entries({ ...values, updated_at: new Date().toISOString() });
  db.prepare(`UPDATE environment_deletions SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE deployment_id=?`)
    .run(...entries.map(([key, value]) => key === 'plan' ? JSON.stringify(value) : value), id);
}
function repository() {
  const [owner, repo] = (config.github.configRepoName || 'Mooroon5-CNP/config-repo').split('/');
  return { owner, repo };
}
async function read(api, repo, path, ref = 'main') {
  try {
    const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...repo, path, ref });
    return Buffer.from(data.content, 'base64').toString();
  } catch (error) { if (error.status === 404) return null; throw error; }
}
function owned(document, dep) {
  return document?.metadata?.labels?.['cnp.io/application'] === dep.appName
    && document.metadata.labels['cnp.io/environment'] === dep.environment;
}
async function inventory(dep, api, repo) {
  const result = { resources: [], buckets: [], files: [], registered: false };
  // A failed onboarding may have collided with someone else's existing directory.
  if (releases.get(dep.id, '__registration__')?.state !== 'registered') return result;
  result.registered = true;
  const dir = `apps/${dep.appName}/crossplane/${dep.environment}`;
  const kustomization = yaml.load(await read(api, repo, `${dir}/kustomization.yaml`) || 'null');
  const names = [...new Set([...filenames, ...(kustomization?.resources || [])])];
  for (const file of names) {
    if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(file)) throw new Error('Manifeste hors du dossier de l’environnement.');
    const raw = await read(api, repo, `apps/${dep.appName}/crossplane/${dep.environment}/${file}`);
    if (raw) result.files.push(file);
    for (const doc of raw ? yaml.loadAll(raw).filter(Boolean) : []) {
      if (!owned(doc, dep) || !kubernetes.CLEANUP_KINDS[`${doc.apiVersion}/${doc.kind}`]) {
        throw new Error(`Propriété ou type non vérifié : ${file}. Aucun retrait automatique de cette ressource.`);
      }
      result.resources.push({ apiVersion: doc.apiVersion, kind: doc.kind, name: doc.metadata.name });
      if (doc.kind === 'Bucket') {
        const policies = doc.spec?.managementPolicies;
        if (policies && !policies.includes('*') && !policies.includes('Create')) {
          throw new Error('Bucket existant en observation : sa destruction requiert une vérification de propriété.');
        }
        result.buckets.push(doc.metadata.name);
      }
    }
  }
  // This file contains references, not the external secret values or ownership.
  if (await read(api, repo, `${dir}/runtime-secrets.yaml`)) result.files.push('runtime-secrets.yaml');
  return result;
}
async function releaseBuckets(dep, row, api, repo) {
  if (!row.plan.buckets.length) return;
  if (!row.destroy_data) throw new Error('Suppression des données non confirmée.');
  const path = `apps/${dep.appName}/crossplane/${dep.environment}/gcs-bucket.yaml`;
  await require('./environment-deployment').commitFiles(api, repo, async head => {
    const raw = await read(api, repo, path, head);
    if (!raw) throw new Error('Manifeste du bucket absent avant sa libération.');
    const docs = yaml.loadAll(raw).filter(Boolean);
    for (const doc of docs) {
      if (!owned(doc, dep)) throw new Error('Le propriétaire du bucket a changé.');
      if (doc.kind !== 'Bucket') continue;
      if (!row.plan.buckets.includes(doc.metadata.name)) throw new Error('Le bucket a changé pendant la suppression.');
      doc.spec.deletionPolicy = 'Delete';
      doc.spec.forProvider.forceDestroy = true;
      if (doc.spec.managementPolicies && !doc.spec.managementPolicies.includes('*') && !doc.spec.managementPolicies.includes('Delete')) {
        doc.spec.managementPolicies.push('Delete');
      }
    }
    return { [path]: docs.map(doc => yaml.dump(doc)).join('---\n') };
  }, `chore(${dep.appName}): authorize ${dep.environment} bucket and data deletion`);
}
async function cleanupRepository(dep) {
  // The other environment, including legacy records, may still use this workflow and secret.
  if (deployments.listForUser(null).some(row => row.id !== dep.id
    && (row.app_name === dep.appName || row.github_repo_url === dep.githubRepoUrl))) return;
  const repo = require('./github').parseRepoUrl(dep.githubRepoUrl);
  if (!repo) throw new Error('Dépôt applicatif invalide.');
  const api = await github.getInstallationOctokit();
  const service = require('./environment-deployment');
  for (const branch of ['main', 'prod']) {
    try {
      await service.commitFiles(api, repo, async head => {
        const files = {};
        for (const path of [`.github/workflows/${service.workflowName(dep.appName)}`, '.cnp-platform-dev', '.cnp-platform-prod']) {
          if (await read(api, repo, path, head) !== null) files[path] = null;
        }
        return files;
      }, `chore(${dep.appName}): remove generated CNP deployment workflow`, branch);
    } catch (error) { if (error.status !== 404) throw error; }
  }
  await github.deleteSecret(repo.owner, repo.repo, 'CONFIG_REPO_TOKEN');
  // Remove only values still matching the GCP variables injected by onboarding.
  // A variable edited by the application owner is outside this cleanup scope.
  if (dep.targetCluster === 'gcp') {
    for (const [name, expected] of [['WIF_PROVIDER', config.github.wifProvider],
      ['GCP_SA_EMAIL', config.github.gcpSaEmail], ['REGISTRY_URL', config.github.registryUrl]]) {
      if (!expected) continue;
      try {
        const { data } = await api.request('GET /repos/{owner}/{repo}/actions/variables/{name}', { ...repo, name });
        if (data.value === expected) await api.request('DELETE /repos/{owner}/{repo}/actions/variables/{name}', { ...repo, name });
      } catch (error) { if (error.status !== 404) throw error; }
    }
  }
}
async function advance(id) {
  schema();
  const claimed = db.prepare(`UPDATE environment_deletions SET lease_until=? WHERE deployment_id=?
    AND state IN ('running','waiting') AND lease_until < ?`).run(Date.now() + 300000, id, Date.now());
  if (!claimed.changes) return;
  try {
    const dep = deployments.get(id), row = get(id);
    if (!dep) { save(id, { state: 'completed' }); return; }
    if (dep.onboardingStatus !== 'deleting') return;
    if (row.state === 'waiting' && Date.now() - Date.parse(row.started_at) > 3600000) {
      throw new Error(`Suppression en attente depuis plus d’une heure : ${row.message || row.step}. Les ressources restantes restent enregistrées ; corrigez la cause puis reprenez la suppression.`);
    }
    const service = require('./environment-deployment');
    if (row.step === 'inventory') {
      const plan = dep.targetCluster === 'gcp'
        ? await inventory(dep, await github.getInstallationOctokit(), repository()) : { resources: [], buckets: [] };
      save(id, { plan, step: 'release', state: 'running', message: 'Inventaire de suppression enregistré.' });
    } else if (row.step === 'release') {
      if (row.plan.buckets.length) {
        await releaseBuckets(dep, row, await github.getInstallationOctokit(), repository());
        save(id, { step: 'release_wait', state: 'waiting', message: 'Autorisation de suppression des données publiée ; attente de Crossplane.' });
      } else save(id, { step: 'remove', state: 'running' });
    } else if (row.step === 'release_wait') {
      for (const resource of row.plan.resources.filter(item => item.kind === 'Bucket')) {
        const body = await kubernetes.getCleanupResource(resource);
        if (body && (!owned(body, dep) || body.spec?.deletionPolicy !== 'Delete' || body.spec?.forProvider?.forceDestroy !== true
          || !body.status?.conditions?.some(item => item.type === 'Synced' && item.status === 'True'))) return;
      }
      save(id, { step: 'remove', state: 'running', message: 'Suppression des données autorisée dans Crossplane.' });
    } else if (row.step === 'remove') {
      await service.remove(dep, { cleanupFiles: row.plan.files || [] });
      save(id, { step: 'verify', state: 'waiting', message: 'Retrait publié ; attente de disparition des ressources.' });
    } else if (row.step === 'verify') {
      const remaining = [];
      if (row.plan.registered !== false && await kubernetes.getArgocdApplicationIfExists(service.identity(dep).name)) remaining.push('Application ArgoCD');
      for (const resource of row.plan.resources) {
        const body = await kubernetes.getCleanupResource(resource);
        if (body) {
          const condition = body.status?.conditions?.find(item => item.status === 'False' && item.message);
          const detail = condition ? ` (${String(condition.message).slice(0, 300)})` : '';
          remaining.push(`${resource.kind}/${resource.name}${detail}`);
        }
      }
      if (remaining.length) { save(id, { state: 'waiting', message: `Suppression en cours : ${remaining.join(', ')}` }); return; }
      save(id, { step: 'repository', state: 'running', message: 'Disparition des ressources confirmée.' });
    } else if (row.step === 'repository') {
      await cleanupRepository(dep);
      db.transaction(() => {
        require('../models/deletion_request').deleteByDeployment(id);
        deployments.delete(id);
        save(id, { state: 'completed', message: 'Environnement et ressources inventoriées supprimés.' });
      })();
    }
  } catch (error) {
    if (error.code === 'CLEANUP_PENDING') save(id, { state: 'waiting', message: error.message });
    else {
      save(id, { state: 'failed', message: error.message });
      if (deployments.get(id)) deployments.updateOnboardingStatus(id, 'delete_failed', error.message);
    }
  } finally { db.prepare('UPDATE environment_deletions SET lease_until=0 WHERE deployment_id=?').run(id); }
}
async function tick() {
  schema();
  for (const row of db.prepare("SELECT deployment_id FROM environment_deletions WHERE state IN ('running','waiting')").all()) {
    await advance(row.deployment_id);
  }
}
module.exports = { get, start, advance, tick };
