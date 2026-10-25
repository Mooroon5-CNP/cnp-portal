'use strict';

const yaml = require('js-yaml');
const { createHash } = require('crypto');
const { config } = require('../config/env');
const github = require('../clients/github');
const repositories = require('./github');
const deployments = require('../models/deployment');
const releases = require('../models/deployment_release');
const kubernetes = require('../clients/kubernetes');
const argo = require('../clients/argocd');

const locks = new Map();
const onboardingLocks = new Map();
const branches = { dev: 'main', prod: 'prod' };
function validate(environment, appName) {
  if (!Object.hasOwn(branches, environment)) throw new Error('Environnement invalide : dev ou prod attendu.');
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(appName)) throw new Error('Nom invalide : 2 à 40 caractères, lettres minuscules, chiffres et tirets.');
}
function target() {
  const [owner, repo] = (config.github.configRepoName || 'Mooroon5-CNP/config-repo').split('/');
  return { owner, repo };
}
function identity(dep) {
  validate(dep.environment, dep.appName);
  return { name: `${dep.appName}-${dep.environment}`, path: `apps/${dep.appName}/crossplane/${dep.environment}` };
}
function workflowName(appName) { return `cnp-${appName}.yml`; }
function image(dep, revision) { return `${config.github.registryUrl || config.gcp.imageRegistry}/${dep.appName}:${revision}`; }
function workflow(appName) {
  return yaml.dump({ name: `CNP — ${appName}`, on: { push: { branches: ['main', 'prod'] } },
    permissions: { contents: 'read', 'id-token': 'write' },
    concurrency: { group: `cnp-${appName}-\${{ github.ref }}`, 'cancel-in-progress': false },
    jobs: { pipeline: {
      uses: `Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml@${process.env.CNP_CI_TEMPLATES_REF || 'main'}`,
      with: { app_name: appName, target_cloud: 'gcp', config_repo_url: `https://github.com/${config.github.configRepoName || 'Mooroon5-CNP/config-repo'}`, gitops_mode: 'portal' },
      secrets: { CONFIG_REPO_TOKEN: '${{ secrets.CONFIG_REPO_TOKEN }}' },
    } },
  }, { lineWidth: -1 });
}

async function readFile(api, repository, path, ref = 'main') {
  try {
    const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...repository, path, ref });
    return Buffer.from(data.content, 'base64').toString();
  } catch (err) { if (err.status === 404) return null; throw err; }
}

// Publier les fichiers ensemble évite un manifeste incomplet pendant la réconciliation.
async function commitFiles(api, repository, files, message, branch = 'main', beforePublish = async () => {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: ref } = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...repository, ref: `heads/${branch}` });
    const { data: commit } = await api.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { ...repository, commit_sha: ref.object.sha });
    const contents = typeof files === 'function' ? await files(ref.object.sha) : files;
    const tree = Object.entries(contents).map(([path, content]) => content === null
      ? { path, mode: '100644', type: 'blob', sha: null }
      : { path, mode: '100644', type: 'blob', content });
    if (!tree.length) return ref.object.sha;
    const { data: nextTree } = await api.request('POST /repos/{owner}/{repo}/git/trees', { ...repository, base_tree: commit.tree.sha, tree });
    if (nextTree.sha === commit.tree.sha) return ref.object.sha;
    const { data: next } = await api.request('POST /repos/{owner}/{repo}/git/commits', { ...repository, message, tree: nextTree.sha, parents: [ref.object.sha] });
    await beforePublish();
    try {
      await api.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { ...repository, ref: `heads/${branch}`, sha: next.sha, force: false });
      return next.sha;
    } catch (err) { if (![409, 422].includes(err.status) || attempt === 2) throw err; }
  }
}

function manifests(dep, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Révision CI invalide.');
  const { name, path } = identity(dep);
  const hash = createHash('sha256').update(`${config.gcp.project}/${name}`).digest('hex').slice(0, 8);
  const bucket = `cnp-${name}-${hash}-data`;
  const metadata = resourceName => ({ name: resourceName, labels: { 'cnp.io/environment': dep.environment, 'cnp.io/application': dep.appName } });
  const container = { image: image(dep, revision), ports: { containerPort: dep.appPort }, env: [
    { name: 'DATA_DIR', value: dep.persistentStorage ? '/data' : '/tmp' },
    { name: 'DD_ENV', value: dep.environment }, { name: 'DD_SERVICE', value: dep.appName },
    { name: 'DD_VERSION', value: revision }, { name: 'LOG_LEVEL', value: 'INFO' },
  ] };
  const template = { serviceAccount: config.gcp.cloudRunSa, containers: [container] };
  if (dep.persistentStorage) {
    template.volumes = [{ name: 'data', gcs: { bucket, readOnly: false } }];
    container.volumeMounts = [{ name: 'data', mountPath: '/data' }];
  }
  const resource = (apiVersion, kind, resourceName, forProvider) => ({ apiVersion, kind, metadata: metadata(resourceName),
    spec: { forProvider, providerConfigRef: { name: 'default' } } });
  const claim = resource('cloudrun.gcp.upbound.io/v1beta2', 'V2Service', name,
    { project: config.gcp.project, location: config.gcp.region, template });
  const iam = resource('cloudrun.gcp.upbound.io/v1beta2', 'ServiceIAMMember', `${name}-public`,
    { project: config.gcp.project, location: config.gcp.region, service: name, role: 'roles/run.invoker', member: 'allUsers' });
  const files = { [`${path}/cloudrun-claim.yaml`]: yaml.dump(claim), [`${path}/cloudrun-iam.yaml`]: yaml.dump(iam) };
  const resources = ['cloudrun-claim.yaml', 'cloudrun-iam.yaml'];
  if (dep.persistentStorage) {
    const storage = resource('storage.gcp.upbound.io/v1beta1', 'Bucket', bucket,
      { project: config.gcp.project, location: config.gcp.region, forceDestroy: false, uniformBucketLevelAccess: true });
    const binding = resource('storage.gcp.upbound.io/v1beta1', 'BucketIAMMember', `${bucket}-runtime`,
      { bucket, role: 'roles/storage.objectAdmin', member: `serviceAccount:${config.gcp.cloudRunSa}` });
    files[`${path}/gcs-bucket.yaml`] = yaml.dump(storage) + '---\n' + yaml.dump(binding);
    resources.push('gcs-bucket.yaml');
  }
  files[`${path}/kustomization.yaml`] = yaml.dump({ apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources });
  return files;
}

function applicationSet() {
  const repoURL = `https://github.com/${config.github.configRepoName || 'Mooroon5-CNP/config-repo'}.git`;
  return { apiVersion: 'argoproj.io/v1alpha1', kind: 'ApplicationSet', metadata: { name: 'cloudrun-environments', namespace: 'argocd' },
    spec: { generators: [{ git: { repoURL, revision: 'main',
      directories: [{ path: 'apps/*/crossplane/dev' }, { path: 'apps/*/crossplane/prod' }] } }],
    template: { metadata: { name: '{{path[1]}}-{{path.basename}}-cloudrun', finalizers: ['resources-finalizer.argocd.argoproj.io'] },
      spec: { project: 'default', source: { repoURL, targetRevision: 'main', path: '{{path}}' },
        destination: { server: 'https://kubernetes.default.svc', namespace: 'crossplane-system' },
        syncPolicy: { automated: { selfHeal: true, prune: true }, syncOptions: ['CreateNamespace=true'] } } } } };
}

function current(dep) {
  const row = deployments.get(dep.id);
  return row && row.environment === dep.environment && row.onboardingStatus === 'ready';
}

async function prepareOnboarding(dep) {
  validate(dep.environment, dep.appName);
  if (!config.github.configRepoToken) throw new Error('Configuration CI GitHub manquante.');
  const api = await github.getInstallationOctokit();
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  const destination = target();
  if (!source) throw new Error('Dépôt GitHub invalide.');
  const registry = yaml.load(await readFile(api, destination, 'apps/registry.yaml') || 'apps: []');
  const key = `${source.owner}/${source.repo}`.toLowerCase();
  const conflict = (registry.apps || []).find(app => {
    const repository = repositories.parseRepoUrl(app.repo_url || '');
    if (!repository) return false;
    const registeredKey = `${repository.owner}/${repository.repo}`.toLowerCase();
    return (app.app_name !== dep.appName && registeredKey === key) || (app.app_name === dep.appName && registeredKey !== key);
  });
  if (conflict) throw new Error(`Ce dépôt ou nom d'application est déjà enregistré : ${conflict.app_name}.`);
  await github.checkActionsEnabled(source.owner, source.repo);
  await github.setRepoSecret(source.owner, source.repo, 'CONFIG_REPO_TOKEN', config.github.configRepoToken);
  for (const [keyName, value] of [['WIF_PROVIDER', config.github.wifProvider], ['GCP_SA_EMAIL', config.github.gcpSaEmail], ['REGISTRY_URL', config.github.registryUrl]]) {
    if (!value) throw new Error(`Configuration manquante : ${keyName}.`);
    await github.setRepoVariable(source.owner, source.repo, keyName, value);
  }
  const main = await github.getRef(source.owner, source.repo, 'main');
  await github.createBranch(source.owner, source.repo, 'prod', main);
  const workflowPath = `.github/workflows/${workflowName(dep.appName)}`;
  for (const branch of ['main', 'prod']) {
    await commitFiles(api, source, async head => {
      const files = { [workflowPath]: workflow(dep.appName) };
      // Retirer uniquement l'ancien caller CNP possédé par la plateforme évite deux builds du même tag.
      const old = await readFile(api, source, '.github/workflows/ci.yml', head);
      if (old) {
        const caller = yaml.load(old)?.jobs?.pipeline;
        if (caller?.uses?.startsWith('Mooroon5-CNP/ci-templates/') && caller.with?.app_name === dep.appName) {
          files['.github/workflows/ci.yml'] = null;
        }
      }
      return files;
    }, `ci(${dep.appName}): configure dev/prod [skip ci]`, branch);
  }
  await kubernetes.applyApplicationSet(applicationSet());
  await commitFiles(api, destination, async head => {
    const doc = yaml.load(await readFile(api, destination, 'apps/registry.yaml', head) || 'apps: []');
    doc.apps ||= [];
    let app = doc.apps.find(item => item.app_name === dep.appName);
    if (!app) { app = { app_name: dep.appName, repo_url: dep.githubRepoUrl, environments: [] }; doc.apps.push(app); }
    app.environments = [...new Set([...(app.environments || []), dep.environment])];
    return { 'apps/registry.yaml': yaml.dump(doc) };
  }, `chore(${dep.appName}): register ${dep.environment}`);
  await commitFiles(api, source, { [`.cnp-platform-${dep.environment}`]: `CNP ${dep.environment}\n${new Date().toISOString()}\n` },
    `ci(${dep.appName}): deploy ${dep.environment}`, branches[dep.environment]);
}

function onboard(dep) {
  if (onboardingLocks.has(dep.id)) return onboardingLocks.get(dep.id);
  const work = prepareOnboarding(dep).finally(() => onboardingLocks.delete(dep.id));
  onboardingLocks.set(dep.id, work);
  return work;
}

async function latest(api, dep) {
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  const { data } = await api.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    ...source, workflow_id: workflowName(dep.appName), branch: branches[dep.environment], per_page: 1,
  });
  const run = data.workflow_runs?.[0];
  if (!run || run.head_branch !== branches[dep.environment]) return null;
  if (dep.createdAt && run.created_at && new Date(run.created_at) < new Date(dep.createdAt)) return null;
  return run;
}

async function sourceIsCurrent(dep, revision) {
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  return await github.getRef(source.owner, source.repo, branches[dep.environment]) === revision;
}

async function readiness(dep, revision) {
  const observed = await kubernetes.getV2ServiceStatus(identity(dep).name);
  if (observed.ready && observed.image === image(dep, revision)) {
    return { phase: 'success', message: 'Application déployée.', cloudRunUrl: observed.url };
  }
  if (observed.failure) return { phase: 'failed', message: `Cloud Run : ${observed.failure}`, cloudRunUrl: null };
  return { phase: 'deploying', message: 'CI terminée ; attente de Cloud Run.', cloudRunUrl: null };
}

async function reconcile(dep) {
  if (locks.has(dep.id)) return locks.get(dep.id);
  const work = (async () => {
    if (!current(dep)) return { phase: 'configuring', message: 'Déploiement non disponible pour publication.' };
    const api = await github.getInstallationOctokit();
    const run = await latest(api, dep);
    if (!run) return { phase: 'waiting', message: 'En attente du pipeline.' };
    const result = { runId: run.id, runUrl: run.html_url, revision: run.head_sha, environment: dep.environment };
    if (run.status !== 'completed') return { ...result, phase: 'running', message: 'Pipeline en cours.' };
    if (run.conclusion !== 'success') return { ...result, phase: 'failed', message: 'Le pipeline a échoué ; aucun déploiement publié.' };
    if (!/^[a-f0-9]{40}$/.test(run.head_sha)) throw new Error('Révision GitHub invalide.');
    const revision = run.head_sha;
    const release = releases.get(dep.id, revision);
    if (release?.state === 'rejected') return { ...result, phase: 'rejected', message: 'Production refusée.' };
    if (release?.state === 'published') return { ...result, ...await readiness(dep, revision) };
    if (!(await sourceIsCurrent(dep, revision))) return { ...result, phase: 'waiting', message: 'La branche a changé ; attente du nouveau pipeline.' };
    if (release?.state === 'pending') return { ...result, phase: 'approval', message: 'Validation manager requise.', prUrl: release.pr_url };
    const token = releases.acquire(dep.id, revision, run.id);
    if (!token) return { ...result, phase: 'deploying', message: 'Préparation GitOps en cours.' };
    const guard = async () => {
      if (!current(dep) || !releases.owns(dep.id, revision, token) || !(await sourceIsCurrent(dep, revision))) {
        throw new Error('Le déploiement ou sa branche a changé. Réessayez.');
      }
    };
    try {
      const files = manifests(dep, revision);
      if (dep.environment === 'dev') {
        await commitFiles(api, target(), files, `deploy(${dep.appName}): dev ${revision}`, 'main', guard);
        releases.save(dep.id, revision, token, 'published');
        return { ...result, ...await readiness(dep, revision) };
      }
      const branch = `cnp-release/${dep.id}/${revision}`;
      const destination = target();
      const main = await github.getRef(destination.owner, destination.repo, 'main');
      await github.createBranch(destination.owner, destination.repo, branch, main);
      const head = await commitFiles(api, destination, files, `deploy(${dep.appName}): prod candidate ${revision}`, branch, guard);
      const { data: prs } = await api.request('GET /repos/{owner}/{repo}/pulls', { ...destination, head: `${destination.owner}:${branch}`, state: 'open' });
      let pr = prs[0];
      if (!pr) {
        await guard();
        const { data } = await api.request('POST /repos/{owner}/{repo}/pulls', { ...destination, title: `Production ${dep.appName} — ${revision.slice(0, 7)}`,
          head: branch, base: 'main', body: `Production candidate from successful CI: ${run.html_url}\n\nApprove through CNP Portal so the GitHub App publishes the protected production path.` });
        pr = data;
      }
      releases.save(dep.id, revision, token, 'pending', { ...pr, head_sha: head });
      return { ...result, phase: 'approval', message: 'Validation manager requise.', prUrl: pr.html_url };
    } finally { releases.release(dep.id, revision, token); }
  })();
  locks.set(dep.id, work);
  try { return await work; } finally { locks.delete(dep.id); }
}

async function review(dep, revision, approve, { reviewedBy } = {}) {
  if (dep.environment !== 'prod' || !current(dep)) throw new Error('Validation réservée à une production active.');
  const release = releases.get(dep.id, revision);
  if (!release || release.state !== 'pending') throw new Error('Candidat non disponible.');
  const api = await github.getInstallationOctokit();
  const run = await latest(api, dep);
  if (!run || run.head_sha !== revision || run.conclusion !== 'success' || !(await sourceIsCurrent(dep, revision))) {
    throw new Error('Candidat obsolète ; attendez le dernier pipeline.');
  }
  const token = releases.acquire(dep.id, revision, run.id);
  if (!token) throw new Error('Une validation est déjà en cours.');
  try {
    if (approve) {
      const { data: pr } = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number });
      if (pr.base.ref !== 'main' || pr.head.sha !== release.head_sha || pr.state !== 'open') throw new Error('Le candidat GitHub a changé. Préparez un nouveau candidat.');
      if (!current(dep) || !(await sourceIsCurrent(dep, revision))) throw new Error('La production a changé pendant la validation.');
      const { data } = await api.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...target(), pull_number: release.pr_number,
        sha: release.head_sha, merge_method: 'squash' });
      if (!data.merged) throw new Error('Le merge GitHub a été refusé.');
      releases.save(dep.id, revision, token, 'published', { reviewedBy });
    } else {
      await api.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number, state: 'closed' });
      releases.save(dep.id, revision, token, 'rejected', { reviewedBy });
    }
  } finally { releases.release(dep.id, revision, token); }
}

async function remove(dep) {
  if (locks.has(dep.id)) await locks.get(dep.id).catch(() => {});
  const api = await github.getInstallationOctokit();
  for (const release of releases.list(dep.id)) {
    if (release.state === 'pending' && release.pr_number) {
      await api.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number, state: 'closed' });
    }
  }
  const { path, name } = identity(dep);
  const files = {};
  for (const file of ['cloudrun-claim.yaml', 'cloudrun-iam.yaml', 'gcs-bucket.yaml', 'kustomization.yaml']) {
    if (await readFile(api, target(), `${path}/${file}`)) files[`${path}/${file}`] = null;
  }
  if (Object.keys(files).length) await commitFiles(api, target(), files, `chore(${dep.appName}): remove ${dep.environment}`);
  await argo.deleteApplication(`${name}-cloudrun`, { cascade: true });
  // Secrets et workflow restent partagés avec l'autre environnement.
}

function startReconciler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const row of deployments.listForUser(null)) {
        const dep = deployments.get(row.id);
        if (!dep || dep.environment === 'legacy') continue;
        if (dep.onboardingStatus === 'configuring') {
          try { await onboard(dep); deployments.updateOnboardingStatus(dep.id, 'ready'); }
          catch (err) { deployments.updateOnboardingStatus(dep.id, 'failed', err.message); }
        } else if (dep.onboardingStatus === 'ready') {
          await reconcile(dep).catch(err => console.warn(`[deployment:${dep.id}] ${err.message}`));
        }
      }
    } finally { running = false; }
  };
  const timer = setInterval(() => tick().catch(err => console.warn(err.message)), 30000);
  timer.unref();
  tick().catch(err => console.warn(err.message));
  return timer;
}

module.exports = { validate, identity, workflow, workflowName, manifests, applicationSet, onboard, reconcile, review, remove, startReconciler, commitFiles };
