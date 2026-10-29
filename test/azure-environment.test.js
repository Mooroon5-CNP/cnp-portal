'use strict';

// Chemin Azure du service d'environnements dev/prod : mêmes garanties que GCP (claims écrits seulement après une CI
// réussie, prod par PR approuvée) + ce qui est propre à Azure (variables AZURE_*, pipeline-azure.yml en mode portail,
// disponibilité lue dans Crossplane, suppression en cascade par l'API Kubernetes).

jest.mock('../src/config/env', () => {
  const azure = {
    namePrefix: 'cnp-sov', regionKey: 'fr', location: 'francecentral', subscriptionId: 'sub-1', tenantId: 'tenant-1',
    ciClientId: 'client-1', acrLoginServer: 'acr.azurecr.io', resourceGroup: 'rg-1', nameSuffix: 'abc123',
    environmentId: '/subscriptions/sub-1/env', environmentDomain: 'env.example.io', pullIdentityId: '/subscriptions/sub-1/uami',
    dbSubnetId: '/subscriptions/sub-1/subnet', dbDnsZoneId: '/subscriptions/sub-1/dns',
  };
  return {
    config: {
      github: { configRepoName: 'team/config', registryUrl: 'registry.test/project/apps', configRepoToken: 'test-pat', wifProvider: 'wif', gcpSaEmail: 'ci@test' },
      gcp: { project: 'test-project', region: 'europe-west9', cloudRunSa: 'run@test' },
      azure,
    },
    getMissingAzureVars: a => ['subscriptionId', 'tenantId', 'ciClientId', 'acrLoginServer', 'resourceGroup', 'nameSuffix',
      'environmentId', 'environmentDomain', 'pullIdentityId', 'dbSubnetId', 'dbDnsZoneId'].filter(k => !a[k]).map(k => `AZURE_${k}`),
  };
});
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn(), getRef: jest.fn(), createBranch: jest.fn(),
  checkActionsEnabled: jest.fn(), setRepoSecret: jest.fn(), setRepoVariable: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({
  applyApplicationSet: jest.fn(), getV2ServiceStatus: jest.fn(), getAzureAppStatus: jest.fn(), cascadeDeleteArgocdApplication: jest.fn(),
  getArgocdApplicationIfExists: jest.fn(),
}));
jest.mock('../src/clients/argocd', () => ({ deleteApplication: jest.fn(), getProject: jest.fn(), getApplicationIfExists: jest.fn() }));
jest.mock('../src/services/application-routing', () => ({ network: jest.fn(() => 'network: test'), sync: jest.fn().mockResolvedValue(), status: jest.fn().mockResolvedValue(true) }));

const yaml = require('js-yaml');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const github = require('../src/clients/github');
const kubernetes = require('../src/clients/kubernetes');
const argo = require('../src/clients/argocd');
const routing = require('../src/services/application-routing');
const service = require('../src/services/environment-deployment');
const releases = require('../src/models/deployment_release');
const revision = 'a'.repeat(40);
let api, run, sourceHead, trees, published, existing, dep;

beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM deployment_releases').run();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
  dep = deployments.create({ environment: 'dev', appName: 'todo', appPort: 8080, targetCluster: 'azure',
    githubRepoUrl: 'https://github.com/team/todo', ownerUserId: 'owner' });
  deployments.updateOnboardingStatus(dep.id, 'ready'); dep = deployments.get(dep.id);
  const registration = releases.acquire(dep.id, '__registration__', 0);
  releases.save(dep.id, '__registration__', registration, 'registered');
  releases.release(dep.id, '__registration__', registration);
  run = { id: 10, head_sha: revision, head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/10' };
  sourceHead = revision; trees = []; published = []; existing = new Map();
  api = { request: jest.fn(async (route, args) => {
    if (route.includes('/actions/workflows/')) return { data: { workflow_runs: [run] } };
    if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
      if (!existing.has(`${args.repo}/${args.path}`)) throw Object.assign(new Error('not found'), { status: 404 });
      const content = existing.get(`${args.repo}/${args.path}`);
      return { data: Array.isArray(content) ? content : { content: Buffer.from(content).toString('base64') } };
    }
    if (route.includes('/git/ref/')) return { data: { object: { sha: 'config-head' } } };
    if (route.startsWith('GET ') && route.includes('/git/commits/')) return { data: { tree: { sha: 'base-tree' } } };
    if (route === 'POST /repos/{owner}/{repo}/git/trees') { trees.push(args); return { data: { sha: `tree-${trees.length}` } }; }
    if (route === 'POST /repos/{owner}/{repo}/git/commits') return { data: { sha: `commit-${trees.length}` } };
    if (route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}') { published.push(args); return { data: {} }; }
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: [] };
    if (route === 'POST /repos/{owner}/{repo}/pulls') return { data: { number: 5, html_url: 'https://example.test/pr/5' } };
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { base: { ref: 'main' }, head: { sha: 'commit-1' }, state: 'open', merged: false } };
    if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') return { data: {} };
    throw new Error(`Unexpected API route ${route}`);
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
  github.getRef.mockImplementation(async (_owner, repo) => repo === 'todo' ? sourceHead : 'config-head');
  kubernetes.getAzureAppStatus.mockResolvedValue({ phase: 'server', failure: null });
  kubernetes.cascadeDeleteArgocdApplication.mockResolvedValue(true);
  kubernetes.getArgocdApplicationIfExists.mockResolvedValue(null);
  argo.getProject.mockImplementation(async name => ({ metadata: { name } }));
  argo.getApplicationIfExists.mockResolvedValue(null);
});

function production() {
  db.prepare("UPDATE deployments SET deployment_environment = 'prod' WHERE id = ?").run(dep.id);
  dep = deployments.get(dep.id); run.head_branch = 'prod';
  return dep;
}

describe('claims par environnement', () => {
  test('dev et prod ont des dossiers, des serveurs, des secrets et des Container Apps distincts', () => {
    const dev = service.manifests(dep, revision), prod = service.manifests({ ...dep, environment: 'prod' }, revision);
    expect(Object.keys(dev).every(path => path.startsWith('apps/todo/crossplane/dev/'))).toBe(true);
    expect(Object.keys(prod).every(path => path.startsWith('apps/todo/crossplane/prod/'))).toBe(true);
    const parse = (files, name) => yaml.load(files[Object.keys(files).find(p => p.endsWith(name))]);
    expect(parse(dev, 'flexibleserver.yaml').metadata.name).toBe('cnp-sov-fr-todo-dev-abc123');
    expect(parse(prod, 'flexibleserver.yaml').metadata.name).toBe('cnp-sov-fr-todo-prod-abc123');
    expect(parse(dev, 'containerapp-claim.yaml').metadata.name).toBe('todo-dev');
    expect(parse(prod, 'containerapp-claim.yaml').metadata.name).toBe('todo-prod');
    expect(parse(dev, 'flexibleserver.yaml').spec.forProvider.tags['cnp-env']).toBe('dev');
    expect(parse(prod, 'flexibleserver.yaml').spec.forProvider.tags['cnp-env']).toBe('prod');
    // aucun nom de ressource Crossplane ni de secret n'est partagé entre les deux environnements
    const names = files => Object.values(files).map(c => yaml.load(c)).filter(d => d.kind !== 'Kustomization').map(d => `${d.kind}/${d.metadata.name}`);
    expect(names(dev).filter(n => names(prod).includes(n))).toEqual([]);
  });

  test('l\'image est la vraie révision de la CI, jamais une image de départ', () => {
    const claim = yaml.load(service.manifests(dep, revision)['apps/todo/crossplane/dev/containerapp-claim.yaml']);
    expect(claim.spec.forProvider.template.container[0].image).toBe(`acr.azurecr.io/todo:${revision}`);
    expect(claim.spec.forProvider.secret[0].valueSecretRef.name).toBe('todo-dev-pg-password');
  });

  test('une révision invalide ou un nom trop long échouent avant toute génération', () => {
    expect(() => service.manifests(dep, 'latest')).toThrow('Révision CI invalide');
    expect(() => service.validate('dev', 'a'.repeat(28), 'azure')).toThrow('trop long');
    expect(() => service.validate('dev', 'todo--x', 'azure')).toThrow();
    expect(() => service.validate('dev', 'todo-azure', 'azure')).not.toThrow();
    // GCP garde sa propre règle
    expect(() => service.validate('dev', 'a'.repeat(30), 'gcp')).not.toThrow();
  });

  test('le workflow appelle pipeline-azure.yml en mode portail sur main et prod', () => {
    const wf = yaml.load(service.workflow(dep.appName, dep));
    expect(wf.jobs.pipeline.uses).toContain('pipeline-azure.yml@');
    expect(wf.jobs.pipeline.with).toEqual(expect.objectContaining({ app_name: 'todo', app_port: '8080', gitops_mode: 'portal' }));
    expect(wf.on.push.branches).toEqual(['main', 'prod']);
    expect(wf.permissions['id-token']).toBe('write');
    expect(yaml.load(service.workflow('pixelcam')).jobs.pipeline.uses).toContain('pipeline.yml@');
  });
});

describe('onboarding Azure', () => {
  test('pose les variables Azure (pas celles de GCP) et le workflow sur main et prod', async () => {
    await service.onboard(dep);
    const names = github.setRepoVariable.mock.calls.map(c => c[2]).sort();
    expect(names).toEqual(['AZURE_ACR_LOGIN_SERVER', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID']);
    expect(github.setRepoSecret).toHaveBeenCalledWith('team', 'todo', 'CONFIG_REPO_TOKEN', 'test-pat');
    const workflowTrees = trees.filter(tree => tree.tree.some(file => file.path === '.github/workflows/cnp-todo.yml'));
    expect(workflowTrees).toHaveLength(2);
    expect(yaml.load(workflowTrees[0].tree[0].content).jobs.pipeline.uses).toContain('pipeline-azure.yml');
    // aucun claim n'est écrit avant la CI
    expect(trees.some(tree => tree.tree.some(file => file.path.includes('/crossplane/') && file.path.endsWith('containerapp-claim.yaml')))).toBe(false);
  });

  test('une configuration Azure incomplète échoue avant toute écriture', async () => {
    const { config } = require('../src/config/env');
    const saved = config.azure.dbDnsZoneId;
    config.azure.dbDnsZoneId = '';
    try {
      await expect(service.onboard(dep)).rejects.toThrow('AZURE_dbDnsZoneId');
      expect(github.setRepoSecret).not.toHaveBeenCalled();
      expect(trees).toHaveLength(0);
    } finally { config.azure.dbDnsZoneId = saved; }
  });
});

describe('publication et disponibilité', () => {
  test('la CI sur main publie le dev Azure une seule fois, et annonce l\'étape en cours', async () => {
    const [first] = await Promise.all([service.reconcile(dep), service.reconcile(dep)]);
    expect(first.phase).toBe('deploying');
    expect(first.message).toContain('serveur PostgreSQL');
    expect(published).toHaveLength(1); expect(published[0].ref).toBe('heads/main');
    expect(trees[0].tree.every(file => file.path.startsWith('apps/todo/crossplane/dev/'))).toBe(true);
    expect(routing.sync).not.toHaveBeenCalled();
    await service.reconcile(dep); expect(published).toHaveLength(1);
  });

  test('« déployée » seulement quand la Container App tourne sur la bonne révision', async () => {
    await service.reconcile(dep);
    kubernetes.getAzureAppStatus.mockResolvedValue({ phase: 'ready', failure: null, observedImage: `acr.azurecr.io/todo:${'b'.repeat(40)}` });
    const stale = await service.reconcile(dep);
    expect(stale.phase).toBe('deploying'); expect(stale.message).toContain('attente de la révision');
    kubernetes.getAzureAppStatus.mockResolvedValue({ phase: 'ready', failure: null, observedImage: `acr.azurecr.io/todo:${revision}` });
    const done = await service.reconcile(dep);
    expect(done.phase).toBe('success');
    expect(done.applicationUrl).toBe('https://todo-dev.env.example.io');
    expect(kubernetes.getAzureAppStatus).toHaveBeenCalledWith('todo', {
      serverName: 'cnp-sov-fr-todo-dev-abc123', databaseName: 'todo-dev-appdb', containerAppName: 'todo-dev',
    });
  });

  test('un échec de création Azure remonte avec sa cause ; une API illisible ne déclare rien', async () => {
    await service.reconcile(dep);
    kubernetes.getAzureAppStatus.mockResolvedValue({ phase: 'failed', failure: 'Container App : image introuvable' });
    const failed = await service.reconcile(dep);
    expect(failed.phase).toBe('failed'); expect(failed.message).toContain('image introuvable');
    kubernetes.getAzureAppStatus.mockRejectedValue(new Error('timeout'));
    expect((await service.reconcile(dep)).phase).toBe('deploying');
  });

  test('la prod ne crée qu\'un candidat (PR) avec les claims Azure de prod', async () => {
    production();
    const result = await service.reconcile(dep);
    expect(result.phase).toBe('approval');
    expect(published.every(p => p.ref.startsWith('heads/cnp-release/'))).toBe(true);
    expect(trees[0].tree.every(file => file.path.startsWith('apps/todo/crossplane/prod/'))).toBe(true);
    expect(trees[0].tree.some(file => file.path.endsWith('flexibleserver.yaml'))).toBe(true);
    expect(routing.sync).not.toHaveBeenCalled();
  });
});

describe('vérification de l\'ancienne application', () => {
  test('Azure lit l\'Application historique par Kubernetes, jamais par l\'API Argo CD (403 pour une application absente)', async () => {
    await service.onboard(dep);
    expect(kubernetes.getArgocdApplicationIfExists).toHaveBeenCalledWith('todo-cloudrun');
    expect(argo.getApplicationIfExists).not.toHaveBeenCalled();
  });

  test('une Application historique existante bloque la préparation, sans écriture', async () => {
    kubernetes.getArgocdApplicationIfExists.mockResolvedValue({ metadata: { name: 'todo-cloudrun' } });
    await expect(service.onboard(dep)).rejects.toThrow('application historique');
    expect(github.setRepoSecret).not.toHaveBeenCalled();
  });
});

describe('suppression', () => {
  beforeEach(() => kubernetes.getAzureAppStatus.mockResolvedValue({ phase: 'ready', failure: null, exists: true, deleting: true }));

  test('supprime seulement l\'environnement choisi : fichiers d\'abord, puis cascade par l\'API Kubernetes, sans routage GCP', async () => {
    production(); await service.reconcile(dep);
    for (const [path, content] of Object.entries(service.manifests(dep, revision))) existing.set(`config/${path}`, content);
    deployments.updateOnboardingStatus(dep.id, 'deleting');
    await service.remove(dep);
    expect(kubernetes.cascadeDeleteArgocdApplication).toHaveBeenCalledWith('todo-prod');
    expect(argo.deleteApplication).not.toHaveBeenCalled();
    expect(routing.sync).not.toHaveBeenCalled();
    const removal = trees.at(-1).tree.filter(file => file.path.startsWith('apps/todo/crossplane/prod/'));
    expect(removal.map(file => file.path.split('/').pop()).sort()).toEqual(
      ['containerapp-claim.yaml', 'containerapp-secretname.yaml', 'flexibleserver-database.yaml', 'flexibleserver.yaml', 'kustomization.yaml']);
    expect(removal.every(file => file.sha === null)).toBe(true);
    // Azure : la cascade vient APRÈS le retrait des fichiers. Tant que le dossier est dans Git, l'ApplicationSet dev
    // (preserveResourcesOnDeletion) retire le finalizer posé et recrée l'Application : ressources orphelines.
    const sourceDelete = api.request.mock.calls.findIndex(([route, args]) => route === 'POST /repos/{owner}/{repo}/git/trees' && args.tree.some(file => file.sha === null));
    expect(kubernetes.cascadeDeleteArgocdApplication.mock.invocationCallOrder[0]).toBeGreaterThan(api.request.mock.invocationCallOrder[sourceDelete]);
  });

  test('un échec de la cascade remonte, pour que la suppression puisse être rejouée', async () => {
    for (const [path, content] of Object.entries(service.manifests(dep, revision))) existing.set(`config/${path}`, content);
    kubernetes.cascadeDeleteArgocdApplication.mockRejectedValue(new Error('refus'));
    deployments.updateOnboardingStatus(dep.id, 'deleting');
    await expect(service.remove(dep)).rejects.toThrow('refus');
  });

  test('une cascade qui n\'a rien supprimé n\'est pas déclarée réussie (ressources orphelines)', async () => {
    for (const [path, content] of Object.entries(service.manifests(dep, revision))) existing.set(`config/${path}`, content);
    kubernetes.getAzureAppStatus.mockResolvedValue({ phase: 'ready', failure: null, exists: true, deleting: false });
    const azureEnv = require('../src/services/environment-azure');
    await expect(azureEnv.confirmTeardown(dep, { attempts: 2, delayMs: 1 })).rejects.toThrow('n\'a pas démarré');
    expect(kubernetes.getAzureAppStatus).toHaveBeenCalledTimes(2);
  });

  test('le démontage est confirmé dès qu\'une ressource est en suppression, ou déjà disparue', async () => {
    const azureEnv = require('../src/services/environment-azure');
    kubernetes.getAzureAppStatus.mockResolvedValue({ exists: true, deleting: true });
    await expect(azureEnv.confirmTeardown(dep, { attempts: 3, delayMs: 1 })).resolves.toBe('deleting');
    kubernetes.getAzureAppStatus.mockResolvedValue({ exists: false, deleting: false });
    await expect(azureEnv.confirmTeardown(dep, { attempts: 3, delayMs: 1 })).resolves.toBe('gone');
  });
});
