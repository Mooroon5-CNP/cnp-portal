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
