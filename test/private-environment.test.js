'use strict';

// Chemin cloud privé (k3s) du service d'environnements dev/prod : mêmes garanties que GCP et Azure (manifestes écrits
// seulement après une CI réussie, prod par PR approuvée, suppression : fichiers, chemin de l'ApplicationSet, puis
// cascade) + ce qui est propre au privé (pipeline.yml en cible aws sans variable, aucun mot de passe préparé par le
// portail, disponibilité lue sur les Object de provider-kubernetes).

jest.mock('../src/config/env', () => {
  const priv = { ecrRegistry: '111.dkr.ecr.eu-west-3.amazonaws.com', appsDomain: 'prive.apps.example.fr',
    providerConfig: 'cnp-prive', certIssuer: 'letsencrypt-prod' };
  return {
    config: {
      github: { configRepoName: 'team/config', registryUrl: 'registry.test/project/apps', configRepoToken: 'test-pat', wifProvider: 'wif', gcpSaEmail: 'ci@test' },
      gcp: { project: 'test-project', region: 'europe-west9', cloudRunSa: 'run@test' },
      azure: {},
      private: priv,
    },
    getMissingAzureVars: () => [],
    getMissingPrivateVars: p => [['ecrRegistry', 'PRIVATE_ECR_REGISTRY'], ['appsDomain', 'PRIVATE_APPS_DOMAIN']]
      .filter(([k]) => !p[k]).map(([, v]) => v),
  };
});
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn(), getRef: jest.fn(), createBranch: jest.fn(),
  checkActionsEnabled: jest.fn(), setRepoSecret: jest.fn(), setRepoVariable: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({
  applyApplicationSet: jest.fn(), getV2ServiceStatus: jest.fn(), getAzureAppStatus: jest.fn(), getPrivateAppStatus: jest.fn(),
  cascadeDeleteArgocdApplication: jest.fn(), getArgocdApplicationIfExists: jest.fn(), removeApplicationSetPath: jest.fn(),
}));
jest.mock('../src/services/failover-operations', () => ({ run: jest.fn().mockResolvedValue({ initialized: true }) }));
jest.mock('../src/clients/argocd', () => ({ deleteApplication: jest.fn(), getProject: jest.fn(), getApplicationIfExists: jest.fn() }));
jest.mock('../src/services/application-routing', () => ({ network: jest.fn(() => 'network: test'), sync: jest.fn().mockResolvedValue(), status: jest.fn().mockResolvedValue(true) }));

const yaml = require('js-yaml');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const github = require('../src/clients/github');
const kubernetes = require('../src/clients/kubernetes');
const argo = require('../src/clients/argocd');
const routing = require('../src/services/application-routing');
const operator = require('../src/services/failover-operations');
const service = require('../src/services/environment-deployment');
const privateEnv = require('../src/services/environment-private');
const releases = require('../src/models/deployment_release');
const revision = 'a'.repeat(40);
const image = `111.dkr.ecr.eu-west-3.amazonaws.com/todo:${revision}`;
let api, run, sourceHead, trees, published, existing, dep;

beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM deployment_releases').run();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
  dep = deployments.create({ environment: 'dev', appName: 'todo', appPort: 8080, targetCluster: 'private-aws',
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
  kubernetes.getPrivateAppStatus.mockResolvedValue({ phase: 'applying', exists: true, deleting: false });
  kubernetes.cascadeDeleteArgocdApplication.mockResolvedValue(true);
  kubernetes.getArgocdApplicationIfExists.mockResolvedValue(null);
  argo.getProject.mockImplementation(async name => ({ metadata: { name } }));
});

function production() {
  db.prepare("UPDATE deployments SET deployment_environment = 'prod' WHERE id = ?").run(dep.id);
  dep = deployments.get(dep.id); run.head_branch = 'prod';
  return dep;
}

describe('modèle et validation', () => {
  test('la cible private-aws est conservée (jamais ramenée à gcp ni confondue avec aws)', () => {
    expect(dep.targetCluster).toBe('private-aws');
  });

  test('le nom réservé de l\'API k3s est refusé', () => {
    expect(() => service.validate('prod', 'k3s-api', 'private-aws')).toThrow('réservé');
    expect(() => service.validate('prod', 'k3s-api', 'gcp')).not.toThrow();
  });
});

describe('onboarding', () => {
  test('pipeline.yml en cible aws sur main et prod, aucune variable de dépôt, aucun mot de passe préparé', async () => {
    await service.onboard(dep);
    expect(github.setRepoVariable).not.toHaveBeenCalled();
    expect(github.setRepoSecret).toHaveBeenCalledWith('team', 'todo', 'CONFIG_REPO_TOKEN', 'test-pat');
    expect(operator.run).not.toHaveBeenCalled();
    const workflowTrees = trees.filter(tree => tree.tree.some(file => file.path === '.github/workflows/cnp-todo.yml'));
    expect(workflowTrees).toHaveLength(2);
    const pipeline = yaml.load(workflowTrees[0].tree[0].content).jobs.pipeline;
    expect(pipeline.uses).toContain('pipeline.yml');
    expect(pipeline.with).toMatchObject({ app_name: 'todo', target_cloud: 'aws', gitops_mode: 'portal' });
    expect(trees.some(tree => tree.tree.some(file => file.path.startsWith('apps/todo/crossplane/dev/')))).toBe(false);
  });

  test('une configuration incomplète échoue avant toute écriture', async () => {
    const { config } = require('../src/config/env');
    const saved = config.private.appsDomain;
    config.private.appsDomain = '';
    try {
      await expect(service.onboard(dep)).rejects.toThrow('PRIVATE_APPS_DOMAIN');
      expect(github.setRepoSecret).not.toHaveBeenCalled();
      expect(trees).toHaveLength(0);
    } finally { config.private.appsDomain = saved; }
  });
});

describe('publication et disponibilité', () => {
  test('la CI sur main publie le dev une seule fois, sous apps/todo/crossplane/dev, sans routage GCP', async () => {
    const [first] = await Promise.all([service.reconcile(dep), service.reconcile(dep)]);
    expect(first.phase).toBe('deploying');
    expect(first.message).toContain('cloud privé');
    expect(published).toHaveLength(1); expect(published[0].ref).toBe('heads/main');
    const paths = trees[0].tree.map(file => file.path).sort();
    expect(paths).toEqual(['app.yaml', 'database.yaml', 'kustomization.yaml', 'namespace.yaml', 'policies.yaml', 'secrets.yaml']
      .map(f => `apps/todo/crossplane/dev/${f}`));
    expect(routing.sync).not.toHaveBeenCalled();
    await service.reconcile(dep); expect(published).toHaveLength(1);
  });

  test('« déployée » seulement quand le Deployment tourne sur la révision ET que l\'adresse HTTPS répond', async () => {
    const fetchBefore = global.fetch;
    try {
      await service.reconcile(dep);
      kubernetes.getPrivateAppStatus.mockResolvedValue({ phase: 'rollout', exists: true, observedImage: image.replace(revision, 'b'.repeat(40)) });
      const stale = await service.reconcile(dep);
      expect(stale).toMatchObject({ phase: 'deploying' }); expect(stale.message).toContain('révision aaaaaaa');
      kubernetes.getPrivateAppStatus.mockResolvedValue({ phase: 'ready', exists: true, observedImage: image });
      global.fetch = jest.fn().mockRejectedValue(new Error('unable to verify the first certificate'));
      const waiting = await service.reconcile(dep);
      expect(waiting.phase).toBe('deploying'); expect(waiting.message).toContain('certificat');
      expect(global.fetch).toHaveBeenCalledWith('https://todo-dev.prive.apps.example.fr/health', expect.objectContaining({ method: 'GET' }));
      global.fetch = jest.fn().mockResolvedValue({ status: 200 });
      const done = await service.reconcile(dep);
      expect(done).toMatchObject({ phase: 'success', applicationUrl: 'https://todo-dev.prive.apps.example.fr' });
      expect(kubernetes.getPrivateAppStatus).toHaveBeenCalledWith('todo', 'dev', { expectedImage: image });
    } finally { global.fetch = fetchBefore; }
  });

  test('un échec remonte avec sa cause ; une API illisible ne déclare rien', async () => {
    await service.reconcile(dep);
    kubernetes.getPrivateAppStatus.mockResolvedValue({ phase: 'failed', exists: true, failure: 'la nouvelle version ne démarre pas' });
    const failed = await service.reconcile(dep);
    expect(failed.phase).toBe('failed'); expect(failed.message).toContain('ne démarre pas');
    kubernetes.getPrivateAppStatus.mockRejectedValue(new Error('timeout'));
    expect((await service.reconcile(dep)).phase).toBe('deploying');
  });

  test('la prod ne crée qu\'un candidat (PR) avec les objets de prod', async () => {
    production();
    const result = await service.reconcile(dep);
    expect(result.phase).toBe('approval');
    expect(published.every(p => p.ref.startsWith('heads/cnp-release/'))).toBe(true);
    expect(trees[0].tree.every(file => file.path.startsWith('apps/todo/crossplane/prod/'))).toBe(true);
    expect(trees[0].tree.find(file => file.path.endsWith('app.yaml')).content).toContain('todo.prive.apps.example.fr');
  });
});

describe('suppression', () => {
  beforeEach(() => kubernetes.getPrivateAppStatus.mockResolvedValue({ exists: true, deleting: true }));

  test('fichiers d\'abord, puis chemin de l\'ApplicationSet, puis cascade et confirmation ; ni routage ni opérateur', async () => {
    production(); await service.reconcile(dep);
    for (const [path, content] of Object.entries(service.manifests(dep, revision))) existing.set(`config/${path}`, content);
    deployments.updateOnboardingStatus(dep.id, 'deleting');
    await service.remove(dep);
    const removal = trees.at(-1).tree.filter(file => file.path.startsWith('apps/todo/crossplane/prod/'));
    expect(removal.map(file => file.path.split('/').pop()).sort())
      .toEqual(['app.yaml', 'database.yaml', 'kustomization.yaml', 'namespace.yaml', 'policies.yaml', 'secrets.yaml']);
    expect(removal.every(file => file.sha === null)).toBe(true);
    expect(kubernetes.removeApplicationSetPath).toHaveBeenCalledWith('crossplane-autodiscovery-prod', 'apps/todo/crossplane/prod');
    expect(kubernetes.cascadeDeleteArgocdApplication).toHaveBeenCalledWith('todo-prod');
    expect(kubernetes.cascadeDeleteArgocdApplication.mock.invocationCallOrder[0])
      .toBeGreaterThan(kubernetes.removeApplicationSetPath.mock.invocationCallOrder[0]);
    expect(kubernetes.getPrivateAppStatus).toHaveBeenCalledWith('todo', 'prod');
    expect(routing.sync).not.toHaveBeenCalled();
    expect(operator.run).not.toHaveBeenCalled();
  });

  test('une cascade qui n\'a rien supprimé n\'est pas déclarée réussie ; disparition ou suppression en cours confirment', async () => {
    kubernetes.getPrivateAppStatus.mockResolvedValue({ exists: true, deleting: false });
    await expect(privateEnv.confirmTeardown(dep, { attempts: 2, delayMs: 1 })).rejects.toThrow('n\'a pas démarré');
    kubernetes.getPrivateAppStatus.mockResolvedValue({ exists: false, deleting: false });
    await expect(privateEnv.confirmTeardown(dep, { attempts: 2, delayMs: 1 })).resolves.toBe('gone');
  });
});
