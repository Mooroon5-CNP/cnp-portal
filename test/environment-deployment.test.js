'use strict';

jest.mock('../src/config/env', () => ({ config: {
  github: { configRepoName: 'team/config', registryUrl: 'registry.test/project/apps', configRepoToken: 'test-pat', wifProvider: 'wif', gcpSaEmail: 'ci@test' },
  gcp: { project: 'test-project', region: 'europe-west9', cloudRunSa: 'run@test' },
} }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn(), getRef: jest.fn(), createBranch: jest.fn(),
  checkActionsEnabled: jest.fn(), setRepoSecret: jest.fn(), setRepoVariable: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({ applyApplicationSet: jest.fn(), getV2ServiceStatus: jest.fn() }));
jest.mock('../src/clients/argocd', () => ({ deleteApplication: jest.fn(), getProject: jest.fn(), getApplicationIfExists: jest.fn() }));

jest.mock('../src/services/application-routing', () => ({ network: jest.fn(() => 'network: test'), sync: jest.fn().mockResolvedValue(), status: jest.fn().mockResolvedValue(true) }));

const yaml = require('js-yaml');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const github = require('../src/clients/github');
const kubernetes = require('../src/clients/kubernetes');
const argo = require('../src/clients/argocd');
const service = require('../src/services/environment-deployment');
const releases = require('../src/models/deployment_release');
const revision = 'a'.repeat(40);
let api, run, sourceHead, trees, published, existing, dep, prHead, mergedBy;

beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM deployment_releases').run();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
  dep = deployments.create({ environment: 'dev', appName: 'pixelcam', appPort: 8080,
    githubRepoUrl: 'https://github.com/team/pixelcalm', persistentStorage: true, ownerUserId: 'owner' });
  deployments.updateOnboardingStatus(dep.id, 'ready'); dep = deployments.get(dep.id);
  const registration = releases.acquire(dep.id, '__registration__', 0);
  releases.save(dep.id, '__registration__', registration, 'registered');
  releases.release(dep.id, '__registration__', registration);
  run = { id: 10, head_sha: revision, head_branch: 'main', status: 'completed', conclusion: 'success', html_url: 'https://example.test/run/10' };
  sourceHead = revision; trees = []; published = []; existing = new Map(); prHead = 'commit-1'; mergedBy = null;
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
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: { base: { ref: 'main' }, head: { sha: prHead }, state: mergedBy ? 'closed' : 'open', merged: Boolean(mergedBy), merged_by: mergedBy ? { login: mergedBy } : null } };
    if (route === 'GET /app') return { data: { slug: 'cnp-platform-bot' } };
    if (route.endsWith('/merge')) return { data: { merged: true } };
    if (route === 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}') return { data: {} };
    throw new Error(`Unexpected API route ${route}`);
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
  github.getRef.mockImplementation(async (_owner, repo) => repo === 'pixelcalm' ? sourceHead : 'config-head');
  kubernetes.getV2ServiceStatus.mockResolvedValue({ ready: false, image: null, url: null });
  argo.getProject.mockImplementation(async name => ({ metadata: { name } }));
  argo.getApplicationIfExists.mockResolvedValue(null);
  argo.deleteApplication.mockResolvedValue();
});

function production() {
  db.prepare("UPDATE deployments SET deployment_environment = 'prod' WHERE id = ?").run(dep.id);
  dep = deployments.get(dep.id); run.head_branch = 'prod';
  return dep;
}

test('dev and prod have distinct services, directories, buckets and observability', () => {
  const dev = service.manifests(dep, revision), prod = service.manifests({ ...dep, environment: 'prod' }, revision);
  expect(Object.keys(dev).every(path => path.startsWith('apps/pixelcam/crossplane/dev/'))).toBe(true);
  expect(Object.keys(prod).every(path => path.startsWith('apps/pixelcam/crossplane/prod/'))).toBe(true);
  const claim = files => yaml.load(files[Object.keys(files).find(path => path.endsWith('cloudrun-claim.yaml'))]);
  const d = claim(dev), p = claim(prod);
  expect(d.metadata.name).toBe('pixelcam-dev'); expect(p.metadata.name).toBe('pixelcam-prod');
  expect(d.spec.forProvider.template.volumes[0].gcs.bucket).not.toBe(p.spec.forProvider.template.volumes[0].gcs.bucket);
  expect(p.spec.forProvider.template.containers[0].env).toContainEqual({ name: 'DD_ENV', value: 'prod' });
  expect(JSON.stringify(dev)).not.toContain('placeholder');
  expect(d.spec.forProvider.template.containers[0].image).toBe(`registry.test/project/apps/pixelcam:${revision}`);
});

test('failed CI cannot publish any resources', async () => {
  run.conclusion = 'failure';
  expect((await service.reconcile(dep)).phase).toBe('failed'); expect(published).toEqual([]);
});

test('main CI publishes dev once and concurrent polls share the same work', async () => {
  const results = await Promise.all([service.reconcile(dep), service.reconcile(dep)]);
  expect(results.every(result => result.phase === 'deploying')).toBe(true);
  expect(published).toHaveLength(1); expect(published[0].ref).toBe('heads/main');
  expect(trees[0].tree.every(file => file.path.startsWith('apps/pixelcam/crossplane/dev/'))).toBe(true);
  await service.reconcile(dep); expect(published).toHaveLength(1);
});

test('a successful run for an outdated source commit cannot publish dev', async () => {
  sourceHead = 'b'.repeat(40);
  expect((await service.reconcile(dep)).phase).toBe('waiting'); expect(published).toHaveLength(0);
});

test('prod CI creates only a candidate and repeated polls do not merge it', async () => {
  production();
  expect((await service.reconcile(dep)).phase).toBe('approval');
  expect(published.every(commit => commit.ref.startsWith('heads/cnp-release/'))).toBe(true);
  await service.reconcile(dep); expect(published).toHaveLength(1);
  expect(api.request.mock.calls.some(([route]) => route.endsWith('/merge'))).toBe(false);
});

test('approval pins the PR head, records reviewer and waits for observed runtime readiness', async () => {
  production(); await service.reconcile(dep); await service.review(dep, revision, true, { reviewedBy: 'manager-id' });
  const merge = api.request.mock.calls.find(([route]) => route.endsWith('/merge'));
  expect(merge[1]).toMatchObject({ pull_number: 5, sha: 'commit-1', merge_method: 'squash' });
  expect(releases.get(dep.id, revision).reviewed_by).toBe('manager-id');
  expect((await service.reconcile(dep)).phase).toBe('deploying');
  kubernetes.getV2ServiceStatus.mockResolvedValue({ ready: true, image: `registry.test/project/apps/pixelcam:${revision}`, url: 'https://prod.test' });
  expect(await service.reconcile(dep)).toMatchObject({ phase: 'success', cloudRunUrl: 'https://prod.test' });
});

test('new prod source and modified candidate PR both invalidate approval', async () => {
  production(); await service.reconcile(dep); sourceHead = 'b'.repeat(40);
  await expect(service.review(dep, revision, true)).rejects.toThrow('Candidat obsolète');
  sourceHead = revision; prHead = 'unexpected-commit';
  await expect(service.review(dep, revision, true)).rejects.toThrow('candidat GitHub a changé');
  expect(api.request.mock.calls.some(([route]) => route.endsWith('/merge'))).toBe(false);
});

test('rejection closes the candidate and remains rejected on subsequent polls', async () => {
  production(); await service.reconcile(dep); await service.review(dep, revision, false, { reviewedBy: 'manager-id' });
  expect(releases.get(dep.id, revision).state).toBe('rejected');
  expect((await service.reconcile(dep)).phase).toBe('rejected'); expect(published).toHaveLength(1);
});

test('a failed GitHub merge never marks production as published', async () => {
  production(); await service.reconcile(dep);
  const original = api.request.getMockImplementation();
  api.request.mockImplementation((route, args) => route.endsWith('/merge') ? { data: { merged: false } } : original(route, args));
  await expect(service.review(dep, revision, true)).rejects.toThrow('merge GitHub');
  expect(releases.get(dep.id, revision).state).toBe('pending');
});

test('setup credentials precede CI trigger and concurrent onboarding does not duplicate triggers', async () => {
  await Promise.all([service.onboard(dep), service.onboard(dep)]);
  const triggerTrees = trees.filter(tree => tree.tree.some(file => file.path === '.cnp-platform-dev'));
  expect(triggerTrees).toHaveLength(1);
  expect(github.setRepoSecret).toHaveBeenCalledTimes(1);
  expect(github.setRepoSecret.mock.invocationCallOrder[0]).toBeLessThan(api.request.mock.invocationCallOrder.at(-1));
  expect(trees.some(tree => tree.repo === 'config' && tree.tree.some(file => file.path.endsWith('cloudrun-claim.yaml')))).toBe(false);
  expect(yaml.load(service.workflow(dep.appName)).jobs.pipeline.with.gitops_mode).toBe('portal');
  expect(yaml.load(service.workflow(dep.appName)).on.push.branches).toEqual(['main', 'prod']);
});

test('setup replaces an owned CNP caller instead of creating a second build workflow', async () => {
  existing.set('pixelcalm/.github/workflows/ci.yml', yaml.dump({ jobs: { pipeline: {
    uses: 'Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml@main', with: { app_name: 'pixelcam' },
  } } }));
  await service.onboard(dep);
  const sourceWorkflowTrees = trees.filter(tree => tree.repo === 'pixelcalm' && tree.tree.some(file => file.path.startsWith('.github/workflows/')));
  expect(sourceWorkflowTrees).toHaveLength(2);
  expect(sourceWorkflowTrees.every(tree => tree.tree.some(file => file.path === '.github/workflows/ci.yml' && file.sha === null))).toBe(true);
});

test('setup preserves custom CI files and rejects another app registered against this repository', async () => {
  existing.set('pixelcalm/.github/workflows/ci.yml', yaml.dump({ jobs: { lint: { 'runs-on': 'ubuntu-latest' } } }));
  await service.onboard(dep);
  expect(trees.every(tree => !tree.tree.some(file => file.path === '.github/workflows/ci.yml'))).toBe(true);
  existing.set('config/apps/registry.yaml', yaml.dump({ apps: [{ app_name: 'other-name', repo_url: dep.githubRepoUrl }] }));
  published.length = 0;
  await expect(service.onboard(dep)).rejects.toThrow('déjà enregistré'); expect(published).toHaveLength(0);
});

test('deletion closes pending candidates and only removes the selected environment', async () => {
  production(); await service.reconcile(dep);
  for (const [path, content] of Object.entries(service.manifests(dep, revision))) existing.set(`config/${path}`, content);
  deployments.updateOnboardingStatus(dep.id, 'deleting');
  await service.remove(dep);
  expect(trees.at(-1).tree.every(file => file.path.startsWith('apps/pixelcam/crossplane/prod/') && file.sha === null)).toBe(true);
  expect(api.request.mock.calls).toContainEqual(['PATCH /repos/{owner}/{repo}/pulls/{pull_number}', expect.objectContaining({ pull_number: 5, state: 'closed' })]);
  expect(argo.deleteApplication).toHaveBeenCalledWith('pixelcam-prod', { cascade: true });
  const sourceDelete = api.request.mock.calls.findIndex(([route, args]) => route === 'POST /repos/{owner}/{repo}/git/trees' && args.tree.some(file => file.sha === null));
  expect(argo.deleteApplication.mock.invocationCallOrder[0]).toBeLessThan(api.request.mock.invocationCallOrder[sourceDelete]);
  expect((await service.reconcile(dep)).phase).toBe('configuring');
});

test('invalid environments and malformed image revisions fail before manifest generation', () => {
  expect(() => service.manifests({ ...dep, environment: 'other' }, revision)).toThrow('Environnement invalide');
  expect(() => service.manifests(dep, 'placeholder')).toThrow('Révision CI invalide');
});

test('deleting dev removes only dev from the registry and preserves prod', async () => {
  existing.set('config/apps/registry.yaml', yaml.dump({ apps: [{ app_name: dep.appName, environments: ['dev', 'prod'] }] }));
  deployments.updateOnboardingStatus(dep.id, 'deleting');
  await service.remove(dep);
  const registry = trees.at(-1).tree.find(file => file.path === 'apps/registry.yaml');
  expect(yaml.load(registry.content).apps[0].environments).toEqual(['prod']);
  expect(trees.at(-1).tree.some(file => file.path.includes('/crossplane/prod/'))).toBe(false);
});

test('an expired lease cannot overwrite the state owned by another worker', () => {
  const token = releases.acquire(dep.id, revision, run.id);
  db.prepare('UPDATE deployment_releases SET lease_until = 0 WHERE deployment_id = ?').run(dep.id);
  const next = releases.acquire(dep.id, revision, run.id);
  expect(next).not.toBe(token);
  expect(() => releases.save(dep.id, revision, token, 'published')).toThrow('a expiré');
  releases.release(dep.id, revision, token);
  expect(releases.owns(dep.id, revision, next)).toBe(true);
});

test('an interrupted merge recovers only the exact candidate merged by the portal App', async () => {
  production(); await service.reconcile(dep);
  const original = api.request.getMockImplementation();
  api.request.mockImplementation((route, args) => {
    if (route.endsWith('/merge')) { mergedBy = 'cnp-platform-bot[bot]'; throw new Error('network response lost'); }
    return original(route, args);
  });
  await expect(service.review(dep, revision, true, { reviewedBy: 'manager-id' })).rejects.toThrow('response lost');
  expect(releases.get(dep.id, revision).state).toBe('approving');
  expect((await service.reconcile(dep)).phase).toBe('deploying');
  expect(releases.get(dep.id, revision)).toMatchObject({ state: 'published', reviewed_by: 'manager-id' });
});

test('an interrupted approval never trusts a merge performed by a human', async () => {
  production(); await service.reconcile(dep);
  const token = releases.acquire(dep.id, revision, run.id);
  releases.save(dep.id, revision, token, 'approving', { reviewedBy: 'manager-id' });
  releases.release(dep.id, revision, token);
  mergedBy = 'human-user';
  expect((await service.reconcile(dep)).phase).toBe('failed');
  expect(releases.get(dep.id, revision).state).toBe('approving');
});

test('setup reuses canonical environment scanners and creates a harmless legacy parent only when absent', async () => {
  await service.onboard(dep);
  expect(kubernetes.applyApplicationSet).toHaveBeenCalledWith(expect.objectContaining({ metadata: { name: 'crossplane-autodiscovery-dev', namespace: 'argocd' } }));
  const set = service.applicationSet('prod');
  expect(set.spec.template.metadata.name).toBe('{{path[1]}}-prod');
  expect(set.spec.template.spec.project).toBe('team-cnp-prod');
  const applied = kubernetes.applyApplicationSet.mock.calls[0][0];
  expect(applied.spec.generators[0].git.directories).toEqual([{ path: 'apps/pixelcam/crossplane/dev' }]);
  expect(applied.spec.generators[0].git.directories.some(directory => directory.path.includes('*'))).toBe(false);
  const root = trees.find(tree => tree.repo === 'config').tree.find(file => file.path === 'apps/pixelcam/crossplane/kustomization.yaml');
  expect(yaml.load(root.content).resources).toEqual([]);
});

test('missing environment project or orphaned legacy application prevents setup before source writes', async () => {
  argo.getProject.mockRejectedValueOnce(new Error('Project missing'));
  await expect(service.onboard(dep)).rejects.toThrow('argocd/projects/team-cnp-dev.yaml');
  expect(published).toHaveLength(0); expect(github.setRepoSecret).not.toHaveBeenCalled();
  argo.getApplicationIfExists.mockResolvedValue({ metadata: { name: 'pixelcam-cloudrun' } });
  await expect(service.onboard(dep)).rejects.toThrow('application historique');
  expect(published).toHaveLength(0);
});

test('setup preserves a real legacy root unchanged', async () => {
  existing.set('config/apps/pixelcam/crossplane/kustomization.yaml', 'resources: [cloudrun-claim.yaml]');
  await service.onboard(dep);
  expect(trees.every(tree => !tree.tree.some(file => file.path === 'apps/pixelcam/crossplane/kustomization.yaml'))).toBe(true);
  expect(argo.getApplicationIfExists).not.toHaveBeenCalled();
});

test('a failed explicit cascade keeps the GitOps source available for cleanup retry', async () => {
  for (const [path, content] of Object.entries(service.manifests(dep, revision))) existing.set(`config/${path}`, content);
  deployments.updateOnboardingStatus(dep.id, 'deleting');
  argo.deleteApplication.mockRejectedValue(new Error('Argo unavailable'));
  await expect(service.remove(dep)).rejects.toThrow('Argo unavailable');
  expect(published).toHaveLength(0); expect(trees).toHaveLength(0);
});

test('setup will not adopt a preexisting historical prod directory without a tracked release', async () => {
  production(); existing.set('config/apps/pixelcam/crossplane/prod/kustomization.yaml', 'resources: [cloudsql-instance.yaml]');
  await expect(service.onboard(dep)).rejects.toThrow('adoption');
  expect(published).toHaveLength(0); expect(github.setRepoSecret).not.toHaveBeenCalled();
});

test('an unrelated historical directory cannot enter the new environment scanner scope', async () => {
  const other = deployments.create({ environment: 'dev', appName: 'historical-app', appPort: 8080, githubRepoUrl: 'https://github.com/team/old', ownerUserId: 'owner' });
  deployments.updateOnboardingStatus(other.id, 'failed');
  await service.onboard(dep);
  expect(kubernetes.applyApplicationSet.mock.calls[0][0].spec.generators[0].git.directories).toEqual([{ path: 'apps/pixelcam/crossplane/dev' }]);
});

test('a parent with direct historical manifests cannot be made into an empty legacy app', async () => {
  existing.set('config/apps/pixelcam/crossplane', [{ type: 'file', name: 'cloudrun-claim.yaml' }]);
  await expect(service.onboard(dep)).rejects.toThrow('manifests historiques');
  expect(published).toHaveLength(0);
});

test('deleting a failed historical-path adoption never removes or touches live resources', async () => {
  db.prepare('DELETE FROM deployment_releases WHERE deployment_id = ?').run(dep.id);
  existing.set('config/apps/pixelcam/crossplane/dev/kustomization.yaml', 'resources: [retained-service.yaml]');
  await expect(service.onboard(dep)).rejects.toThrow('adoption');
  api.request.mockClear();
  deployments.updateOnboardingStatus(dep.id, 'deleting');
  await service.remove(dep);
  expect(api.request).not.toHaveBeenCalled();
  expect(argo.deleteApplication).not.toHaveBeenCalled();
  expect(published).toHaveLength(0);
});

test('persistent storage sync waits for bucket and IAM before starting the Cloud Run revision', () => {
  const files = service.manifests(dep, revision);
  const path = `apps/${dep.appName}/crossplane/dev`;
  const [bucket, binding] = yaml.loadAll(files[`${path}/gcs-bucket.yaml`]);
  const runtime = yaml.load(files[`${path}/cloudrun-claim.yaml`]);
  const publicIam = yaml.load(files[`${path}/cloudrun-iam.yaml`]);
  const wave = resource => Number(resource.metadata.annotations['argocd.argoproj.io/sync-wave']);
  expect(wave(bucket)).toBeLessThan(wave(binding));
  expect(wave(binding)).toBeLessThan(wave(runtime));
  expect(wave(runtime)).toBeLessThan(wave(publicIam));
});

test('a ready runtime stays deploying while friendly routing is unavailable and production candidates publish no host', async () => {
  const routing = require('../src/services/application-routing');
  kubernetes.getV2ServiceStatus.mockResolvedValue({ ready: true, image: `registry.test/project/apps/pixelcam:${revision}`, url: 'https://runtime.test' });
  routing.status.mockResolvedValueOnce(false);
  expect(await service.reconcile(dep)).toMatchObject({ phase: 'deploying', cloudRunUrl: null });
  expect(routing.sync).toHaveBeenCalledTimes(1);
  production(); db.prepare("DELETE FROM deployment_releases WHERE revision != ?").run("__registration__"); routing.sync.mockClear();
  expect((await service.reconcile(dep)).phase).toBe('approval');
  expect(routing.sync).not.toHaveBeenCalled();
});
