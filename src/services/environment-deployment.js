'use strict';

const yaml = require('js-yaml');
const { selectWorkflowRun } = require('./workflow-runs');
const { createHash } = require('crypto');
const { config } = require('../config/env');
const github = require('../clients/github');
const repositories = require('./github');
const deployments = require('../models/deployment');
const releases = require('../models/deployment_release');
const kubernetes = require('../clients/kubernetes');
const argo = require('../clients/argocd');
const routing = require('./application-routing');
const addresses = require('./application-address');
const azure = require('./environment-azure');
const failover = require('./environment-failover');

const locks = new Map();
const onboardingLocks = new Map();
const branches = { dev: 'main', prod: 'prod' };
function validate(environment, appName, targetCluster) {
  if (!Object.hasOwn(branches, environment)) throw new Error('Environnement invalide : dev ou prod attendu.');
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(appName)) throw new Error('Nom invalide : 2 à 40 caractères, lettres minuscules, chiffres et tirets.');
  if (targetCluster === 'azure') azure.validate(appName);
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
function workflow(appName, dep = {}) {
  if (azure.isAzure(dep)) return azure.workflow(dep, process.env.CNP_CI_TEMPLATES_REF);
  const document = { name: `CNP — ${appName}`, on: { push: { branches: ['main', 'prod'] } },
    permissions: { contents: 'read', 'id-token': 'write' },
    concurrency: { group: `cnp-${appName}-\${{ github.ref }}`, 'cancel-in-progress': false },
    jobs: { pipeline: {
      uses: `Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml@${process.env.CNP_CI_TEMPLATES_REF || 'main'}`,
      with: { app_name: appName, target_cloud: dep.failoverRequested || failover.enabled(dep) ? 'both' : 'gcp', config_repo_url: `https://github.com/${config.github.configRepoName || 'Mooroon5-CNP/config-repo'}`, gitops_mode: 'portal', app_port: String(dep.appPort || 8080) },
      secrets: { CONFIG_REPO_TOKEN: '${{ secrets.CONFIG_REPO_TOKEN }}' },
    } },
  };
  if (dep.failoverRequested || failover.enabled(dep)) {
    document.jobs['failover-images'] = {
      needs: ['pipeline'], 'runs-on': 'ubuntu-latest',
      if: "${{ github.ref == 'refs/heads/prod' && needs.pipeline.result == 'success' }}",
      steps: [{ name: 'Record immutable images', env: {
        CNP_APP: appName, CNP_REVISION: '${{ github.sha }}', CNP_DIGEST: '${{ needs.pipeline.outputs.image_digest }}',
        CNP_GCP_REGISTRY: config.github.registryUrl || config.gcp.imageRegistry,
      }, run: `python3 - <<'PY'
import json, os, re
assert re.fullmatch(r'sha256:[a-f0-9]{64}', os.environ['CNP_DIGEST'])
app, digest = os.environ['CNP_APP'], os.environ['CNP_DIGEST']
record = {'app': app, 'revision': os.environ['CNP_REVISION'], 'digest': digest,
    'gcp': os.environ['CNP_GCP_REGISTRY'] + '/' + app + '@' + digest,
    'aws': '804210702561.dkr.ecr.eu-west-3.amazonaws.com/' + app + '@' + digest}
with open('cnp-images.json', 'w') as file: json.dump(record, file)
PY` }, { uses: 'actions/upload-artifact@v4', with: {
        name: 'cnp-failover-images-${{ github.sha }}', path: 'cnp-images.json', 'if-no-files-found': 'error', 'retention-days': 30,
      } }],
    };
  }
  return yaml.dump(document, { lineWidth: -1 });
}

async function configureFailoverBuild(dep, user) {
  if (!user || user.role !== 'manager' || !user.id || dep.environment !== 'prod'
    || dep.targetCluster !== 'gcp' || !failover.enabled(dep)) throw new Error('Configuration failover manager requise.');
  const api = await github.getInstallationOctokit();
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  if (!source) throw new Error('Dépôt applicatif invalide.');
  await github.checkActionsEnabled(source.owner, source.repo);
  for (const [name, value] of [['WIF_PROVIDER', config.github.wifProvider], ['GCP_SA_EMAIL', config.github.gcpSaEmail], ['REGISTRY_URL', config.github.registryUrl]]) {
    if (!value) throw new Error(`Configuration CI manquante : ${name}.`);
    await github.setRepoVariable(source.owner, source.repo, name, value);
  }
  if (!config.github.configRepoToken) throw new Error('Configuration CI GitHub manquante.');
  await github.setRepoSecret(source.owner, source.repo, 'CONFIG_REPO_TOKEN', config.github.configRepoToken);
  const file = `.github/workflows/${workflowName(dep.appName)}`;
  for (const branch of ['main', 'prod']) {
    await commitFiles(api, source, { [file]: workflow(dep.appName, { ...dep, failoverRequested: true }) },
      `ci(${dep.appName}): publish failover image provenance`, branch);
  }
  return { configured: true, cloudChanged: false };
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
  if (azure.isAzure(dep)) return azure.manifests(dep, revision);
  if (dep.failoverRequested && !failover.enabled(dep)) throw new Error('Profil de secours de cette application absent.');
  if (failover.enabled(dep)) return failover.manifests(dep);
  const { name, path } = identity(dep);
  const hash = createHash('sha256').update(`${config.gcp.project}/${name}`).digest('hex').slice(0, 8);
  const bucket = `cnp-${name}-${hash}-data`;
  const metadata = resourceName => ({ name: resourceName, annotations: { 'argocd.argoproj.io/sync-wave': resourceName === name ? '2' : resourceName.endsWith('-runtime') ? '1' : resourceName.endsWith('-public') ? '3' : '0' }, labels: { 'cnp.io/environment': dep.environment, 'cnp.io/application': dep.appName } });
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
  files[`${path}/application-network.yaml`] = routing.network(dep);
  const resources = ['cloudrun-claim.yaml', 'cloudrun-iam.yaml', 'application-network.yaml'];
  if (dep.persistentStorage) {
    const storage = resource('storage.gcp.upbound.io/v1beta1', 'Bucket', bucket,
      { project: config.gcp.project, location: config.gcp.region, forceDestroy: false, uniformBucketLevelAccess: true });
    storage.spec.deletionPolicy = 'Orphan';
    const binding = resource('storage.gcp.upbound.io/v1beta1', 'BucketIAMMember', `${bucket}-runtime`,
      { bucket, role: 'roles/storage.objectAdmin', member: `serviceAccount:${config.gcp.cloudRunSa}` });
    files[`${path}/gcs-bucket.yaml`] = yaml.dump(storage) + '---\n' + yaml.dump(binding);
    resources.push('gcs-bucket.yaml');
  }
  if (dep.database === 'postgres') {
    // Base PostgreSQL de l'app (dev, sans failover). Cloud Run s'y connecte par la connexion Cloud SQL intégrée (socket
    // /cloudsql/<instance>, rôle roles/cloudsql.client du compte runtime) : IP publique SANS aucun réseau autorisé, seul ce
    // connecteur authentifié et chiffré l'atteint. Le mot de passe est créé avant publication (Secret Kubernetes lu par
    // Crossplane, copie Secret Manager lue par Cloud Run). Supprimée avec l'app : aucune protection, deletionPolicy Delete.
    const instance = `${name}-db-${createHash('sha256').update(dep.id).digest('hex').slice(0, 6)}`;   // nom bloqué ~1 semaine après suppression
    const secret = { name: `cnp-${name}-sql`, namespace: 'crossplane-system', key: 'runtime-password' };
    const wave = (object, value) => { object.metadata.annotations['argocd.argoproj.io/sync-wave'] = String(value); return object; };
    const sqlInstance = wave(resource('sql.gcp.upbound.io/v1beta2', 'DatabaseInstance', `${name}-db`, {
      project: config.gcp.project, region: config.gcp.region, databaseVersion: 'POSTGRES_15', deletionProtection: false,
      settings: { edition: 'ENTERPRISE', tier: 'db-f1-micro', availabilityType: 'ZONAL', diskSize: 10, diskAutoresize: true,
        deletionProtectionEnabled: false, backupConfiguration: { enabled: false },
        ipConfiguration: { ipv4Enabled: true, sslMode: 'ENCRYPTED_ONLY' } } }), 0);
    sqlInstance.metadata.annotations['crossplane.io/external-name'] = instance;
    const sqlDatabase = wave(resource('sql.gcp.upbound.io/v1beta1', 'Database', `${name}-db-app`,
      { project: config.gcp.project, instanceRef: { name: `${name}-db` } }), 1);
    sqlDatabase.metadata.annotations['crossplane.io/external-name'] = 'appdb';
    const sqlUser = wave(resource('sql.gcp.upbound.io/v1beta2', 'User', `${name}-db-user`,
      { project: config.gcp.project, type: 'BUILT_IN', instanceRef: { name: `${name}-db` }, passwordSecretRef: secret }), 1);
    sqlUser.metadata.annotations['crossplane.io/external-name'] = 'cnp_runtime';
    for (const object of [sqlInstance, sqlDatabase, sqlUser]) object.spec.deletionPolicy = 'Delete';
    files[`${path}/cloudsql.yaml`] = [sqlInstance, sqlDatabase, sqlUser].map(object => yaml.dump(object)).join('---\n');
    resources.push('cloudsql.yaml');
    const connection = `${config.gcp.project}:${config.gcp.region}:${instance}`;
    template.volumes = [...(template.volumes || []), { name: 'cloudsql', cloudSqlInstance: { instances: [connection] } }];
    container.volumeMounts = [...(container.volumeMounts || []), { name: 'cloudsql', mountPath: '/cloudsql' }];
    container.env.push({ name: 'DB_HOST', value: `/cloudsql/${connection}` }, { name: 'DB_PORT', value: '5432' },
      { name: 'DB_NAME', value: 'appdb' }, { name: 'DB_USER', value: 'cnp_runtime' }, { name: 'DB_ENGINE', value: 'postgres' },
      { name: 'DB_PASSWORD', valueSource: { secretKeyRef: { secret: `${name}-db-password`, version: 'latest' } } });
    files[`${path}/cloudrun-claim.yaml`] = yaml.dump(claim);           // réécrit avec le socket et les variables de la base
  }
  files[`${path}/kustomization.yaml`] = yaml.dump({ apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources });
  return files;
}

function applicationSet(environment = 'dev', paths = []) {
  if (!Object.hasOwn(branches, environment)) throw new Error('Environnement invalide.');
  const repoURL = `https://github.com/${config.github.configRepoName || 'Mooroon5-CNP/config-repo'}.git`;
  const set = { apiVersion: 'argoproj.io/v1alpha1', kind: 'ApplicationSet', metadata: { name: `crossplane-autodiscovery-${environment}`, namespace: 'argocd' },
    spec: { generators: [{ git: { repoURL, revision: 'main', directories: [...new Set(paths)].sort().map(path => ({ path })) } }],
    template: { metadata: { name: `{{path[1]}}-${environment}` },
      spec: { project: `team-cnp-${environment}`, source: { repoURL, targetRevision: 'main', path: '{{path}}' },
        destination: { server: 'https://kubernetes.default.svc', namespace: 'crossplane-system' },
        syncPolicy: { automated: { selfHeal: true, prune: true }, syncOptions: ['CreateNamespace=true'] } } } } };
  set.spec.syncPolicy = { preserveResourcesOnDeletion: true, applicationsSync: 'create-update' };
  return set;
}

function current(dep) {
  const row = deployments.get(dep.id);
  return row && row.environment === dep.environment && row.onboardingStatus === 'ready'
    && releases.get(dep.id, '__registration__')?.state === 'registered';
}

// Mot de passe de la base Cloud SQL d'une app de dev : créé (une seule fois) avant toute publication, car Crossplane le lit pour
// créer l'utilisateur et Cloud Run dans Secret Manager. Par l'opérateur Python (clients Kubernetes et Secret Manager).
async function databaseSecrets(dep, action) {
  if (dep.database !== 'postgres' || azure.isAzure(dep)) return null;
  const operator = require('./failover-operations');
  return operator.run({ action, app: dep.appName, environment: dep.environment, service_account: config.gcp.cloudRunSa });
}

async function prepareOnboarding(dep) {
  validate(dep.environment, dep.appName, dep.targetCluster);
  if (!config.github.configRepoToken) throw new Error('Configuration CI GitHub manquante.');
  if (azure.isAzure(dep)) azure.assertConfigured();
  await databaseSecrets(dep, 'app-sql-secrets');
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
  if (conflict) throw new Error(`Ce dépôt ou nom d'application est déjà enregistré : ${conflict.app_name}, dans ${config.github.configRepoName}/apps/registry.yaml. Ce contrôle précède le lancement du pipeline. Le registre GitOps peut contenir des entrées absentes de la base locale du portail ; un administrateur doit vérifier l’entrée existante avant toute réutilisation ou correction.`);
  // Réutiliser les projets et scanners canoniques ; aucun second propriétaire Argo.
  let project;
  try { project = await argo.getProject(`team-cnp-${dep.environment}`); }
  catch (_) {
    throw new Error(`Projet Argo CD team-cnp-${dep.environment} absent ou inaccessible. Un opérateur doit appliquer argocd/projects/team-cnp-${dep.environment}.yaml avant ce déploiement.`);
  }
  if (project.metadata?.name !== `team-cnp-${dep.environment}`) throw new Error('AppProject environnement indisponible.');
  const rootPath = `apps/${dep.appName}/crossplane/kustomization.yaml`;
  const selectedPath = `${identity(dep).path}/kustomization.yaml`;
  if (await readFile(api, destination, selectedPath)) {
    const registered = releases.get(dep.id, '__registration__')?.state === 'registered';
    if (!registered || !releases.list(dep.id).some(release => release.state === 'published')) {
      throw new Error('Un environnement GitOps existe déjà à ce chemin. Son adoption doit être validée par un opérateur.');
    }
  }
  const ensureEmptyRootAllowed = async (ref = 'main') => {
    try {
      const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...destination, path: `apps/${dep.appName}/crossplane`, ref });
      if (Array.isArray(data) && data.some(entry => entry.type === 'file' && /\.(ya?ml|json)$/.test(entry.name))) {
        throw new Error('Des manifests historiques existent à la racine. Leur adoption doit être validée par un opérateur.');
      }
    } catch (err) { if (err.status !== 404) throw err; }
    // Kubernetes distinguishes absence (404) from forbidden (403). The scoped
    // Argo CD API can return 403 for absent applications, on GCP as on Azure.
    const legacyApplication = await kubernetes.getArgocdApplicationIfExists(`${dep.appName}-cloudrun`);
    if (legacyApplication) {
      throw new Error('Une application historique existe sans son manifeste racine. Restaurez sa configuration avant de créer un environnement.');
    }
  };
  if (!(await readFile(api, destination, rootPath))) await ensureEmptyRootAllowed();
  await github.checkActionsEnabled(source.owner, source.repo);
  await github.setRepoSecret(source.owner, source.repo, 'CONFIG_REPO_TOKEN', config.github.configRepoToken);
  // Variables lues par le pipeline du cloud : WIF/Artifact Registry pour GCP, identité fédérée et ACR pour Azure.
  const repoVariables = azure.isAzure(dep)
    ? azure.repoVariables()
    : [['WIF_PROVIDER', config.github.wifProvider], ['GCP_SA_EMAIL', config.github.gcpSaEmail], ['REGISTRY_URL', config.github.registryUrl]];
  for (const [keyName, value] of repoVariables) {
    if (!value) throw new Error(`Configuration manquante : ${keyName}.`);
    await github.setRepoVariable(source.owner, source.repo, keyName, value);
  }
  const main = await github.getRef(source.owner, source.repo, 'main');
  await github.createBranch(source.owner, source.repo, 'prod', main);
  const workflowPath = `.github/workflows/${workflowName(dep.appName)}`;
  for (const branch of ['main', 'prod']) {
    await commitFiles(api, source, async head => {
      const files = { [workflowPath]: workflow(dep.appName, dep) };
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
  const registrationToken = releases.acquire(dep.id, '__registration__', 0);
  if (!registrationToken) throw new Error('Enregistrement du déploiement déjà en cours. Réessayez.');
  try { releases.save(dep.id, '__registration__', registrationToken, 'registered'); }
  finally { releases.release(dep.id, '__registration__', registrationToken); }
  const registeredPaths = deployments.listForUser(null)
    .filter(row => row.deployment_environment === dep.environment && releases.get(row.id, '__registration__')?.state === 'registered')
    .map(row => `apps/${row.app_name}/crossplane/${dep.environment}`);
  await kubernetes.applyApplicationSet(applicationSet(dep.environment, registeredPaths));
  await commitFiles(api, destination, async head => {
    const doc = yaml.load(await readFile(api, destination, 'apps/registry.yaml', head) || 'apps: []');
    doc.apps ||= [];
    let app = doc.apps.find(item => item.app_name === dep.appName);
    if (!app) { app = { app_name: dep.appName, repo_url: dep.githubRepoUrl, environments: [] }; doc.apps.push(app); }
    app.environments = [...new Set([...(app.environments || []), dep.environment])];
    const files = { 'apps/registry.yaml': yaml.dump(doc) };
    if (!(await readFile(api, destination, rootPath, head))) {
      await ensureEmptyRootAllowed(head);
      // Le scanner historique peut voir ce parent, mais il ne gère aucune ressource.
      // Ne jamais remplacer un vrai manifeste historique : cela en déclencherait le prune.
      files[rootPath] = yaml.dump({ apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources: [] });
    }
    return files;
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
    ...source, workflow_id: workflowName(dep.appName), branch: branches[dep.environment], per_page: 20,
  });
  const revision = await github.getRef(source.owner, source.repo, branches[dep.environment]);
  return selectWorkflowRun(data.workflow_runs || [], { branch: branches[dep.environment], revision, notBefore: dep.createdAt });
}

async function sourceIsCurrent(dep, revision) {
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  return await github.getRef(source.owner, source.repo, branches[dep.environment]) === revision;
}

async function readiness(dep, revision) {
  if (azure.isAzure(dep)) return azure.readiness(dep, revision);
  if (failover.enabled(dep)) return failover.readiness(dep);
  const observed = await kubernetes.getV2ServiceStatus(identity(dep).name);
  if (observed.ready && observed.image === image(dep, revision)) {
    const api = await github.getInstallationOctokit();
    await routing.sync(dep, { api, repo: target(), commitFiles, beforePublish: async () => {
      if (!current(dep)) throw new Error('Le déploiement a changé pendant la préparation du routage.');
    } });
    if (!(await routing.status(dep))) return { phase: 'deploying', message: 'Cloud Run disponible ; attente du routage HTTPS.', cloudRunUrl: null };
    return { phase: 'success', message: 'Application déployée.', cloudRunUrl: observed.url, applicationUrl: addresses.url(dep) };
  }
  if (observed.image !== image(dep, revision)) {
    return { phase: 'deploying', message: 'Nouvelle image publiée dans GitOps ; attente de son application par ArgoCD/Crossplane.', cloudRunUrl: null };
  }
  if (observed.failure) return { phase: 'failed', message: `Cloud Run : ${observed.failure}`, cloudRunUrl: null };
  return { phase: 'deploying', message: 'CI terminée ; attente de Cloud Run.', cloudRunUrl: null };
}

async function interruptedApproval(api, dep, release) {
  const { data: pr } = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number });
  if (pr.base.ref !== 'main' || pr.head.sha !== release.head_sha) {
    return { phase: 'failed', message: 'Le candidat GitHub a changé depuis la validation.' };
  }
  if (!pr.merged) {
    return pr.state === 'open'
      ? { phase: 'approval', message: 'Validation interrompue ; un manager peut réessayer.', prUrl: release.pr_url }
      : { phase: 'rejected', message: 'Le candidat de production a été fermé.' };
  }
  const { data: app } = await api.request('GET /app');
  if (!app.slug || pr.merged_by?.login !== `${app.slug}[bot]`) {
    return { phase: 'failed', message: 'Merge effectué hors du portail ; vérification manager requise.' };
  }
  const token = releases.acquire(dep.id, release.revision, release.run_id);
  if (!token) return { phase: 'deploying', message: 'Vérification de la publication en cours.' };
  try { releases.save(dep.id, release.revision, token, 'published'); }
  finally { releases.release(dep.id, release.revision, token); }
  return readiness(dep, release.revision);
}

async function reconcile(dep) {
  // Seule décision humaine, comme pour toute prod : un manager confirme ; le secours se met ensuite en service seul.
  if (dep.failoverRequested && !failover.enabled(dep)) return { phase: 'approval', message: 'Production avec failover : en attente de la confirmation d’un manager.', failoverConfirm: true };
  if (failover.enabled(dep) && dep.onboardingStatus === 'ready' && current(dep)) return failover.deploymentStatus(dep);
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
    if (release?.state === 'approving') return { ...result, ...await interruptedApproval(api, dep, release) };
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
      // Un autre processus a pu terminer entre la lecture et l'acquisition du bail.
      const fresh = releases.get(dep.id, revision);
      if (fresh.state === 'published') return { ...result, ...await readiness(dep, revision) };
      if (fresh.state === 'rejected') return { ...result, phase: 'rejected', message: 'Production refusée.' };
      if (['pending', 'approving'].includes(fresh.state)) return { ...result, phase: 'approval', message: 'Validation manager requise.', prUrl: fresh.pr_url };
      const files = manifests(dep, revision);
      if (!azure.isAzure(dep)) {
        // Operator-managed Secret Manager references survive image promotions.
        const runtime = yaml.load(await readFile(api, target(), `${identity(dep).path}/runtime-secrets.yaml`) || '[]');
        if (!Array.isArray(runtime) || runtime.some(item => !/^[A-Z_][A-Z0-9_]*$/.test(item?.name || '')
          || !item?.valueSource?.secretKeyRef?.secret || !item?.valueSource?.secretKeyRef?.version
          || Object.keys(item).some(key => !['name', 'valueSource'].includes(key)))) throw new Error('Invalid runtime secret references.');
        const claimPath = `${identity(dep).path}/cloudrun-claim.yaml`;
        const claim = yaml.load(files[claimPath]);
        const container = claim.spec.forProvider.template.containers[0];
        container.env = container.env.filter(item => !runtime.some(secret => secret.name === item.name)).concat(runtime);
        files[claimPath] = yaml.dump(claim);
      }
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
  if (!release || !['pending', 'approving'].includes(release.state)) throw new Error('Candidat non disponible.');
  const api = await github.getInstallationOctokit();
  const run = await latest(api, dep);
  if (!run || run.head_sha !== revision || run.conclusion !== 'success' || !(await sourceIsCurrent(dep, revision))) {
    throw new Error('Candidat obsolète ; attendez le dernier pipeline.');
  }
  const token = releases.acquire(dep.id, revision, run.id);
  if (!token) throw new Error('Une validation est déjà en cours.');
  try {
    const fresh = releases.get(dep.id, revision);
    if (!['pending', 'approving'].includes(fresh.state) || fresh.head_sha !== release.head_sha || fresh.pr_number !== release.pr_number) {
      throw new Error('Cette validation a déjà été traitée.');
    }
    if (approve) {
      const { data: pr } = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number });
      if (pr.base.ref !== 'main' || pr.head.sha !== release.head_sha || pr.state !== 'open') throw new Error('Le candidat GitHub a changé. Préparez un nouveau candidat.');
      if (!current(dep) || !(await sourceIsCurrent(dep, revision))) throw new Error('La production a changé pendant la validation.');
      releases.save(dep.id, revision, token, 'approving', { reviewedBy });
      const { data } = await api.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...target(), pull_number: release.pr_number,
        sha: release.head_sha, merge_method: 'squash' });
      if (!data.merged) {
        releases.save(dep.id, revision, token, 'pending');
        throw new Error('Le merge GitHub a été refusé.');
      }
      releases.save(dep.id, revision, token, 'published');
    } else {
      await api.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number, state: 'closed' });
      releases.save(dep.id, revision, token, 'rejected', { reviewedBy });
    }
  } finally { releases.release(dep.id, revision, token); }
}

async function remove(dep, { afterFailoverTeardown = false } = {}) {
  // Une app failover se supprime par failover-teardown (bases, secours, secrets), qui termine en appelant cette fonction.
  if (failover.enabled(dep) && !afterFailoverTeardown) throw new Error('Suppression complète du failover requise d’abord.');
  if (onboardingLocks.has(dep.id)) await onboardingLocks.get(dep.id).catch(() => {});
  if (locks.has(dep.id)) await locks.get(dep.id).catch(() => {});
  // Une préflight échouée ne donne aucun droit sur des manifests historiques.
  if (releases.get(dep.id, '__registration__')?.state !== 'registered') return;
  const api = await github.getInstallationOctokit();
  for (const release of releases.list(dep.id)) {
    if (['pending', 'approving'].includes(release.state) && release.pr_number) {
      const { data: pr } = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number });
      if (pr.state === 'open') await api.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...target(), pull_number: release.pr_number, state: 'closed' });
    }
  }
  const { path, name } = identity(dep);
  const onAzure = azure.isAzure(dep);
  const files = {};
  const claimFiles = onAzure ? azure.fileNames() : ['cloudrun-claim.yaml', 'cloudrun-iam.yaml', 'gcs-bucket.yaml', 'cloudsql.yaml', 'application-network.yaml', 'kustomization.yaml'];
  for (const file of claimFiles) {
    if (await readFile(api, target(), `${path}/${file}`)) files[`${path}/${file}`] = null;
  }
  if (!onAzure) {
    const application = await kubernetes.getArgocdApplicationIfExists(name);
    const hasRuntime = Object.keys(files).length > 0 || application
      || releases.list(dep.id).some(release => release.state === 'published');
    // A failed CI may never have published any resource or route. In that case
    // remove only its registration; do not wait on a route that was never created.
    if (hasRuntime) {
      await routing.sync(dep, { api, repo: target(), commitFiles }, true);
      if (!(await routing.status(dep, true))) throw new Error('Retrait du routage en cours. Réessayez la suppression après synchronisation Argo CD.');
      // Preserve the existing GCP cascade-before-source-removal ordering, using
      // the scoped Kubernetes client already used for Azure (no Argo REST 415/403).
      // Après la suppression du failover, l'Application est retirée seulement APRÈS le dossier (plus bas), comme pour Azure.
      if (!afterFailoverTeardown) await kubernetes.cascadeDeleteArgocdApplication(name);
    }
  }
  const hasLegacy = deployments.listForUser(null).some(row => row.app_name === dep.appName && row.deployment_environment === 'legacy');
  await commitFiles(api, target(), async head => {
    const result = { ...files };
    const raw = !hasLegacy && await readFile(api, target(), 'apps/registry.yaml', head);
    if (raw) {
      const registry = yaml.load(raw);
      const app = registry.apps?.find(item => item.app_name === dep.appName);
      if (app) {
        app.environments = (app.environments || []).filter(environment => environment !== dep.environment);
        if (!app.environments.length) registry.apps = registry.apps.filter(item => item !== app);
        result['apps/registry.yaml'] = yaml.dump(registry);
      }
    }
    return result;
  }, `chore(${dep.appName}): remove ${dep.environment}`);
  // Le dossier est sorti de Git : son chemin quitte aussi la liste explicite de l'ApplicationSet de cet environnement.
  if (!onAzure) await kubernetes.removeApplicationSetPath(`crossplane-autodiscovery-${dep.environment}`, `apps/${dep.appName}/crossplane/${dep.environment}`);
  // Azure : la cascade vient APRÈS le retrait des fichiers (ordre inverse de GCP, voir environment-azure.confirmTeardown).
  // Tant que le dossier est dans Git, l'ApplicationSet dev (preserveResourcesOnDeletion) retire le finalizer posé et
  // recrée l'Application : les ressources Azure restaient orphelines (constaté le 29/10/2026). L'API Kubernetes, car
  // l'API Argo CD refuse ce compte.
  if (onAzure) {
    await kubernetes.cascadeDeleteArgocdApplication(name);
    await azure.confirmTeardown(dep);
  }
  // Failover : les ressources sont déjà détruites. L'ApplicationSet (create-update) ne supprime jamais d'Application : c'est au
  // portail de la retirer, une fois le dossier sorti de Git. Retirée avant, alors que le dossier existait encore, le contrôleur
  // ne l'a plus recréée au redéploiement suivant (06/11/2026, réparé par un redémarrage du contrôleur) ; laissée, elle restait.
  if (afterFailoverTeardown) await kubernetes.cascadeDeleteArgocdApplication(name);
  // Base Cloud SQL de dev : ses manifestes sont retirés avec le reste (vagues Argo : Cloud Run, puis base et utilisateur, puis
  // instance) ; ses deux secrets partent ensuite.
  await databaseSecrets(dep, 'app-sql-cleanup');
  // Secrets et workflow restent partagés avec l'autre environnement.
}

async function resumeAfterCleanupFailure(dep) {
  if (deployments.get(dep.id)?.onboardingStatus !== 'delete_failed') throw new Error('Aucune suppression en échec à reprendre.');
  if (releases.get(dep.id, '__registration__')?.state !== 'registered') throw new Error('Configuration incomplète : terminez la suppression avant de recréer le déploiement.');
  const api = await github.getInstallationOctokit();
  const registry = yaml.load(await readFile(api, target(), 'apps/registry.yaml') || 'apps: []');
  const source = repositories.parseRepoUrl(dep.githubRepoUrl);
  const entry = registry.apps?.find(app => {
    const repo = repositories.parseRepoUrl(app.repo_url || '');
    return app.app_name === dep.appName && repo && source && `${repo.owner}/${repo.repo}`.toLowerCase() === `${source.owner}/${source.repo}`.toLowerCase()
      && app.environments?.includes(dep.environment);
  });
  if (!entry) throw new Error('La configuration GitOps a déjà été retirée. Terminez la suppression avant de redéployer.');
  const application = await kubernetes.getArgocdApplicationIfExists(identity(dep).name);
  if (application?.metadata?.deletionTimestamp) throw new Error('La suppression des ressources a déjà commencé. Terminez-la avant de redéployer.');
  const published = releases.list(dep.id).some(release => release.state === 'published');
  if (published && (!application || !(await readFile(api, target(), `${identity(dep).path}/kustomization.yaml`)))) {
    throw new Error('Les ressources publiées ont commencé à disparaître. Terminez la suppression avant de redéployer.');
  }
  if (deployments.get(dep.id)?.onboardingStatus !== 'delete_failed') throw new Error('Le déploiement a changé. Réessayez.');
  deployments.updateOnboardingStatus(dep.id, 'ready');
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
          try {
            await onboard(dep);
            if (deployments.get(dep.id)?.onboardingStatus === 'configuring') deployments.updateOnboardingStatus(dep.id, 'ready');
          } catch (err) {
            if (deployments.get(dep.id)?.onboardingStatus === 'configuring') deployments.updateOnboardingStatus(dep.id, 'failed', err.message);
          }
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

// Dossier de production orphelin : l'app n'existe plus (ni déploiement dans le portail, ni registre, ni Application Argo CD),
// mais ses manifestes restent sous apps/<app>/crossplane/prod. Seul le bot du portail peut écrire sous ce chemin (garde
// protect-prod-paths de config-repo) : ce retrait passe donc par lui, comme toute écriture de production. Il ne détruit rien
// dans le cloud (les ressources doivent déjà avoir disparu) ; il empêche seulement une ancienne app de renaître.
async function removeOrphanProduction(appName, user) {
  if (!user?.id || user.role !== 'manager') throw new Error('Validation manager requise.');
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(appName || '')) throw new Error('Nom d’application invalide.');
  if (deployments.listForUser(null).some(row => row.app_name === appName)) throw new Error('Application connue du portail : utiliser sa suppression.');
  if (await kubernetes.getArgocdApplicationIfExists(`${appName}-prod`)) throw new Error('Application Argo CD de production encore présente : retirer ses ressources d’abord.');
  const api = await github.getInstallationOctokit();
  const registry = yaml.load(await readFile(api, target(), 'apps/registry.yaml') || 'apps: []');
  if (registry.apps?.some(item => item.app_name === appName)) throw new Error('Application encore inscrite au registre.');
  const prefix = `apps/${appName}/crossplane/prod/`;
  const { data: ref } = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...target(), ref: 'heads/main' });
  const { data: tree } = await api.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { ...target(), tree_sha: ref.object.sha, recursive: 'true' });
  const paths = tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith(prefix)).map(entry => entry.path);
  if (!paths.length) return { removed: 0 };
  await commitFiles(api, target(), Object.fromEntries(paths.map(path => [path, null])), `chore(${appName}): remove orphaned prod folder`);
  return { removed: paths.length };
}

module.exports = { configureFailoverBuild, validate, identity, workflow, workflowName, manifests, applicationSet, onboard, reconcile, review, remove, resumeAfterCleanupFailure, startReconciler, commitFiles, removeOrphanProduction };
