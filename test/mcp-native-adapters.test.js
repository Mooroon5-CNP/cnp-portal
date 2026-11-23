'use strict';

const { createNativeAdapters } = require('../apps/orchestrator/src/sources/native-adapters.cjs');
class SourceError extends Error { constructor(code, source) { super(code); this.code = code; this.source = source; } }
const settings = { github: { configRepoName: 'test/config', configRepoToken: 'test' }, datadog: {}, kubernetes: {} };
const registry = `apps:\n  - app_name: real-app\n    team_owner: platform\n    repo_url: https://example.com/real-app\n    environments: [dev, prod]\n`;
const claim = `kind: V2Service\nspec:\n  forProvider:\n    template:\n      containers:\n        - image: registry.example/real-app:0123456789012345678901234567890123456789\n`;
function create() {
  const getFileWithSha = jest.fn(async (_owner, _repo, path) => {
    if (path === 'apps/registry.yaml') return { content: registry };
    if (path === 'apps/real-app/crossplane/cloudrun-claim.yaml') return { content: claim };
    const error = new Error('missing'); error.response = { status: 404 }; throw error;
  });
  return { adapter: createNativeAdapters({ SourceError, settings, githubClient: { getFileWithSha } }), getFileWithSha };
}

test('real catalog is contract-shaped, filters environments and rejects invalid cursors', async () => {
  const { adapter } = create();
  expect(adapter.platform.mode).toBe('real');
  const result = await adapter.platform.list({ environment: 'prod', limit: 20 });
  expect(result.applications[0]).toMatchObject({ applicationId: 'real-app', team: 'platform' });
  expect(result.nextCursor).toBeNull();
  await expect(adapter.platform.list({ cursor: 'invalid', limit: 20 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('shared Cloud Run dev claim is never represented as prod observed/desired state', async () => {
  const { adapter } = create();
  expect(await adapter.git.desired('real-app', 'dev')).toMatchObject({ version: '0123456789012345678901234567890123456789', imageDigest: null });
  expect(await adapter.platform.workload('real-app', 'dev')).toEqual({ platform: 'cloud_run', stateless: true, http: true, requiresKubernetes: false });
  await expect(adapter.git.desired('real-app', 'prod')).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' });
});

test('source outages are errors and never silently become mock or empty data', async () => {
  const { adapter } = create();
  await expect(adapter.datadog.logs({ applicationId: 'real-app', environment: 'dev' })).rejects.toMatchObject({ code: 'OBSERVABILITY_NOT_CONFIGURED' });
  await expect(adapter.datadog.metrics('real-app', 'dev', 7)).rejects.toMatchObject({ code: 'OBSERVABILITY_NOT_CONFIGURED' });
  const error = new Error('offline');
  const failing = createNativeAdapters({ SourceError, settings, githubClient: { getFileWithSha: async () => { throw error; } } });
  await expect(failing.platform.list({ limit: 20 })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

test('environment claims and runtimes take precedence over a preserved legacy Argo application', async () => {
  const git = { getFileWithSha: jest.fn(async (_owner, _repo, path) => {
    if (path === 'apps/registry.yaml') return { content: registry };
    const env = path.match(/crossplane\/(dev|prod)\/cloudrun-claim.yaml$/)?.[1];
    if (env) return { content: claim.replace('kind: V2Service', `kind: V2Service\nmetadata:\n  name: real-app-${env}`) };
    if (path.endsWith('crossplane/application.yaml')) return { content: 'metadata:\n  name: legacy-app' };
    const error = new Error('missing'); error.response = { status: 404 }; throw error;
  }) };
  const argoClient = { getApplicationDetails: jest.fn(async () => ({ status: {
    summary: { images: ['registry.test/wrong:desired-only'] }, sync: { status: 'Synced' }, health: { status: 'Healthy' },
  } })) };
  const runtimeClient = { getV2ServiceStatus: jest.fn(async name => ({ ready: true,
    image: `registry.test/app:${name}-serving`, failure: null })) };
  const adapter = createNativeAdapters({ SourceError, settings, githubClient: git, argoClient, runtimeClient });
  for (const env of ['dev', 'prod']) {
    expect(await adapter.argo.observed('real-app', env)).toMatchObject({ version: `real-app-${env}-serving`, healthStatus: 'Healthy' });
    expect(argoClient.getApplicationDetails).toHaveBeenLastCalledWith(`real-app-${env}`);
    expect(runtimeClient.getV2ServiceStatus).toHaveBeenLastCalledWith(`real-app-${env}`);
  }
  expect(git.getFileWithSha.mock.calls.some(call => call[2].endsWith('crossplane/application.yaml'))).toBe(false);
  runtimeClient.getV2ServiceStatus.mockResolvedValue({ ready: false, image: 'registry.test/app:desired-only', failure: 'Container failed' });
  expect(await adapter.argo.observed('real-app', 'dev')).toMatchObject({ version: null, healthStatus: 'Degraded' });
});

test('legacy dev uses its declared Argo owner and never grants an unregistered environment', async () => {
  const argoClient = { getApplicationDetails: jest.fn(async () => ({ status: {} })) };
  const runtimeClient = { getV2ServiceStatus: jest.fn(async () => ({ ready: true, image: 'registry.test/app:serving' })) };
  const githubClient = { getFileWithSha: async (_owner, _repo, path) => {
    if (path === 'apps/registry.yaml') return { content: registry.replace('[dev, prod]', '[dev]') };
    if (path.endsWith('crossplane/cloudrun-claim.yaml')) return { content: claim };
    if (path.endsWith('crossplane/application.yaml')) return { content: 'metadata:\n  name: real-app-cloudrun' };
    const error = new Error('missing'); error.response = { status: 404 }; throw error;
  } };
  const adapter = createNativeAdapters({ SourceError, settings, githubClient, argoClient, runtimeClient });
  expect(await adapter.argo.observed('real-app', 'dev')).toMatchObject({ version: 'serving' });
  expect(argoClient.getApplicationDetails).toHaveBeenCalledWith('real-app-cloudrun');
  expect(runtimeClient.getV2ServiceStatus).toHaveBeenCalledWith('real-app');
  await expect(adapter.git.desired('real-app', 'prod')).rejects.toMatchObject({ code: 'ENVIRONMENT_NOT_FOUND' });
});

describe('Azure Container Apps (SPEC-MCP-AZURE-DEPLOYMENT-STATUS)', () => {
  const azureClaim = (env) => `apiVersion: containerapp.azure.upbound.io/v1beta2\nkind: ContainerApp\nmetadata:\n  name: real-app-${env}\nspec:\n  forProvider:\n    template:\n      container:\n        - name: app\n          image: acr.example/real-app:abcdefabcdefabcdefabcdefabcdefabcdefabcd\n`;
  function azure(runtime) {
    const getFileWithSha = jest.fn(async (_owner, _repo, path) => {
      if (path === 'apps/registry.yaml') return { content: registry };
      const env = path.match(/^apps\/real-app\/crossplane\/(dev|prod)\/containerapp-claim\.yaml$/)?.[1];
      if (env) return { content: azureClaim(env) };
      const error = new Error('missing'); error.response = { status: 404 }; throw error;
    });
    const argoClient = { getApplicationDetails: jest.fn(async () => ({ status: { sync: { status: 'Synced' }, health: { status: 'Healthy' },
      operationState: { finishedAt: '2026-11-23T16:49:00Z' }, summary: { images: [] } } })) };
    const runtimeClient = { getAzureContainerAppStatus: jest.fn(async () => runtime), getV2ServiceStatus: jest.fn() };
    return { adapter: createNativeAdapters({ SourceError, settings, githubClient: { getFileWithSha }, argoClient, runtimeClient }), argoClient, runtimeClient };
  }

  test('desired and observed state come from the ContainerApp claim and its Crossplane status', async () => {
    const { adapter, argoClient, runtimeClient } = azure({ exists: true, ready: true, image: 'acr.example/real-app:abcdefabcdefabcdefabcdefabcdefabcdefabcd', failure: null });
    for (const env of ['dev', 'prod']) {
      expect(await adapter.git.desired('real-app', env)).toEqual({ version: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', imageDigest: null, sourceRevision: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' });
      expect(await adapter.argo.observed('real-app', env)).toEqual({ version: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd', imageDigest: null,
        syncStatus: 'Synced', healthStatus: 'Healthy', lastDeploymentAt: '2026-11-23T16:49:00Z' });
      expect(argoClient.getApplicationDetails).toHaveBeenLastCalledWith(`real-app-${env}`);
      expect(runtimeClient.getAzureContainerAppStatus).toHaveBeenLastCalledWith(`real-app-${env}`);
    }
    expect(runtimeClient.getV2ServiceStatus).not.toHaveBeenCalled();
  });

  test('the image is only reported once the Container App is ready; a failure is Degraded', async () => {
    const pending = azure({ exists: true, ready: false, image: 'acr.example/real-app:old', failure: null });
    expect(await pending.adapter.argo.observed('real-app', 'dev')).toMatchObject({ version: null, healthStatus: 'Progressing' });
    const failed = azure({ exists: true, ready: false, image: null, failure: 'LinkedAuthorizationFailed' });
    expect(await failed.adapter.argo.observed('real-app', 'dev')).toMatchObject({ healthStatus: 'Degraded' });
  });

  test('workload is unknown (contract has no Azure value) and the Kubernetes digest is not applicable', async () => {
    const { adapter } = azure({ exists: true, ready: true, image: null, failure: null });
    expect(await adapter.platform.workload('real-app', 'dev')).toBeNull();
    await expect(adapter.kubernetes.imageDigest('real-app', 'dev')).rejects.toMatchObject({ code: 'SOURCE_NOT_CONFIGURED' });
  });
});
