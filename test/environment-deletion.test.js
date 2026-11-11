'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'team/config', wifProvider: 'expected-wif', gcpSaEmail: 'expected-sa', registryUrl: 'expected-registry' } } }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn(), deleteSecret: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({
  CLEANUP_KINDS: { 'storage.gcp.upbound.io/v1beta1/Bucket': 'buckets', 'cloudrun.gcp.upbound.io/v1beta2/V2Service': 'v2services' },
  getCleanupResource: jest.fn(), getArgocdApplicationIfExists: jest.fn(),
}));
jest.mock('../src/services/environment-deployment', () => ({ remove: jest.fn(), commitFiles: jest.fn(),
  identity: dep => ({ name: `${dep.appName}-${dep.environment}` }), workflowName: app => `cnp-${app}.yml` }));
const yaml = require('js-yaml');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const releases = require('../src/models/deployment_release');
const github = require('../src/clients/github');
const kubernetes = require('../src/clients/kubernetes');
const deployment = require('../src/services/environment-deployment');
const cleanup = require('../src/services/environment-deletion');
const user = { id: 'manager', role: 'manager' };
let dep, files, bucket, api;

beforeEach(() => {
  jest.resetAllMocks();
  db.exec('DROP TABLE IF EXISTS environment_deletions');
  db.prepare('DELETE FROM deployment_releases').run();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
  dep = deployments.create({ appName: 'test-app', environment: 'dev', githubRepoUrl: 'https://github.com/team/test-app', ownerUserId: user.id, persistentStorage: true });
  const token = releases.acquire(dep.id, '__registration__', 0);
  releases.save(dep.id, '__registration__', token, 'registered');
  releases.release(dep.id, '__registration__', token);
  bucket = { apiVersion: 'storage.gcp.upbound.io/v1beta1', kind: 'Bucket', metadata: { name: 'test-app-dev-data',
    labels: { 'cnp.io/application': 'test-app', 'cnp.io/environment': 'dev' } },
  spec: { deletionPolicy: 'Orphan', forProvider: { forceDestroy: false } } };
  files = new Map([['config/apps/test-app/crossplane/dev/gcs-bucket.yaml', yaml.dump(bucket)],
    ['test-app/.github/workflows/cnp-test-app.yml', 'generated workflow']]);
  api = { request: jest.fn(async (_route, args) => {
    const content = files.get(`${args.repo}/${args.path}`);
    if (content === undefined) throw Object.assign(new Error('not found'), { status: 404 });
    return { data: { content: Buffer.from(content).toString('base64') } };
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
  github.deleteSecret.mockResolvedValue();
  deployment.commitFiles.mockImplementation(async (api, repo, fn) => {
    const updates = await fn('latest-head');
    for (const [path, content] of Object.entries(updates)) {
      if (content === null) files.delete(`${repo.repo}/${path}`);
      else files.set(`${repo.repo}/${path}`, content);
    }
  });
  deployment.remove.mockResolvedValue();
  kubernetes.getCleanupResource.mockResolvedValue(null);
  kubernetes.getArgocdApplicationIfExists.mockResolvedValue(null);
});
const start = () => cleanup.start(dep, user, { destroyData: true });
const step = () => cleanup.advance(dep.id);

test('complete deletion waits for bucket release and actual disappearance before forgetting the deployment', async () => {
  start(); await step(); // inventory
  expect(cleanup.get(dep.id).plan.resources).toContainEqual({ apiVersion: bucket.apiVersion, kind: 'Bucket', name: bucket.metadata.name });
  await step(); // release in Git
  const released = yaml.load(files.get('config/apps/test-app/crossplane/dev/gcs-bucket.yaml'));
  expect(released.spec).toMatchObject({ deletionPolicy: 'Delete', forProvider: { forceDestroy: true } });
  kubernetes.getCleanupResource.mockResolvedValue(bucket);
  await step();
  expect(deployment.remove).not.toHaveBeenCalled();
  kubernetes.getCleanupResource.mockResolvedValue({ ...released, status: { conditions: [{ type: 'Synced', status: 'True' }] } });
  await step(); await step(); // release observed, withdrawal requested
  expect(deployment.remove).toHaveBeenCalledTimes(1);
  await step();
  expect(deployments.get(dep.id)).not.toBeNull();
  expect(cleanup.get(dep.id)).toMatchObject({ state: 'waiting', step: 'verify' });
  kubernetes.getCleanupResource.mockResolvedValue(null);
  await step(); await step();
  expect(deployments.get(dep.id)).toBeNull();
  expect(cleanup.get(dep.id).state).toBe('completed');
  expect(files.has('test-app/.github/workflows/cnp-test-app.yml')).toBe(false);
  expect(github.deleteSecret).toHaveBeenCalledWith('team', 'test-app', 'CONFIG_REPO_TOKEN');
});

test('route waiting is retried automatically and persists across service reloads', async () => {
  start(); await step(); await step(); await step();
  deployment.remove.mockRejectedValueOnce(Object.assign(new Error('Routing pending'), { code: 'CLEANUP_PENDING' }));
  await step();
  expect(cleanup.get(dep.id)).toMatchObject({ state: 'waiting', step: 'remove' });
  expect(deployments.get(dep.id).onboardingStatus).toBe('deleting');
  const resumed = require('../src/services/environment-deletion');
  await resumed.tick();
  expect(cleanup.get(dep.id).step).toBe('verify');
});

test('provider errors retain the durable inventory and an explicit retry resumes the same step', async () => {
  start(); await step(); await step(); await step();
  deployment.remove.mockRejectedValueOnce(new Error('Provider forbidden'));
  await step();
  expect(deployments.get(dep.id).onboardingStatus).toBe('delete_failed');
  const plan = cleanup.get(dep.id).plan;
  start();
  expect(cleanup.get(dep.id).plan).toEqual(plan);
  await step();
  expect(cleanup.get(dep.id).step).toBe('verify');
});

test('data destruction needs an explicit confirmation, and a developer cannot start deletion', () => {
  expect(() => cleanup.start(dep, user)).toThrow('données');
  expect(() => cleanup.start(dep, { id: 'dev', role: 'dev' }, { destroyData: true })).toThrow('manager');
  expect(deployments.get(dep.id).onboardingStatus).toBe('configuring');
});

test('a foreign bucket or an observe-only bucket blocks destructive preparation', async () => {
  bucket.metadata.labels['cnp.io/application'] = 'other-app';
  files.set('config/apps/test-app/crossplane/dev/gcs-bucket.yaml', yaml.dump(bucket));
  start(); await step();
  expect(cleanup.get(dep.id).state).toBe('failed');
  expect(deployment.commitFiles).not.toHaveBeenCalled();
  bucket.metadata.labels['cnp.io/application'] = 'test-app';
  bucket.spec.managementPolicies = ['Observe'];
  files.set('config/apps/test-app/crossplane/dev/gcs-bucket.yaml', yaml.dump(bucket));
  start(); await step();
  expect(cleanup.get(dep.id).message).toContain('observation');
});

test('a sibling environment retains the application workflow and repository secret', async () => {
  const sibling = deployments.create({ appName: 'test-app', environment: 'prod', githubRepoUrl: dep.githubRepoUrl, ownerUserId: user.id });
  start();
  for (let i = 0; i < 7; i++) await step();
  expect(deployments.get(dep.id)).toBeNull();
  expect(deployments.get(sibling.id)).not.toBeNull();
  expect(files.has('test-app/.github/workflows/cnp-test-app.yml')).toBe(true);
  expect(github.deleteSecret).not.toHaveBeenCalled();
});

test('a Kubernetes authorization failure during verification cannot be interpreted as absence', async () => {
  start(); await step(); await step(); await step(); await step();
  kubernetes.getCleanupResource.mockRejectedValue(new Error('Kubernetes forbidden'));
  await step();
  expect(cleanup.get(dep.id).state).toBe('failed');
  expect(deployments.get(dep.id)).not.toBeNull();
  expect(github.deleteSecret).not.toHaveBeenCalled();
});


test('a stuck deletion keeps the inventory and offers a retry after the bounded wait', async () => {
  start(); await step(); await step();
  db.prepare('UPDATE environment_deletions SET started_at=? WHERE deployment_id=?').run(new Date(Date.now() - 3700000).toISOString(), dep.id);
  await step();
  expect(cleanup.get(dep.id)).toMatchObject({ state: 'failed', step: 'release_wait' });
  expect(cleanup.get(dep.id).message).toContain('plus d’une heure');
  start(); await step();
  expect(cleanup.get(dep.id).step).toBe('remove');
});


test('last-environment cleanup deletes only unchanged CNP variables and keeps a customized value', async () => {
  const original = api.request.getMockImplementation();
  api.request.mockImplementation(async (route, args) => {
    if (route === 'GET /repos/{owner}/{repo}/actions/variables/{name}') {
      return { data: { value: args.name === 'WIF_PROVIDER' ? 'expected-wif' : 'customized-by-user' } };
    }
    if (route === 'DELETE /repos/{owner}/{repo}/actions/variables/{name}') return { data: {} };
    return original(route, args);
  });
  start();
  for (let i = 0; i < 7; i++) await step();
  const deleted = api.request.mock.calls.filter(([route]) => route.startsWith('DELETE ')).map(([, args]) => args.name);
  expect(deleted).toEqual(['WIF_PROVIDER']);
  expect(cleanup.get(dep.id).state).toBe('completed');
});
