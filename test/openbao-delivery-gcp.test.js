'use strict';

const { GcpVariableDelivery, secretId } = require('../src/services/openbao-delivery-gcp');

const dep = { appName: 'sample-app', environment: 'dev', targetCluster: 'gcp' };

test('creates a regional secret, grants only the runtime identity and returns a pinned reference', async () => {
  const id = secretId(dep, 'API_KEY');
  let created = false;
  const transport = { request: jest.fn(async ({ method, url }) => {
    if (url.endsWith(`/secrets/${id}`)) {
      if (!created) throw Object.assign(new Error('missing'), { response: { status: 404 } });
      return { data: { labels: { cnp_app: dep.appName, cnp_env: dep.environment, cnp_owner: 'portal_variables' } } };
    }
    if (url.endsWith('/secrets') && method === 'POST') { created = true; return { data: {} }; }
    if (url.endsWith(':getIamPolicy')) return { data: { bindings: [], etag: 'etag-1' } };
    if (url.endsWith(':setIamPolicy')) return { data: {} };
    if (url.endsWith(':addVersion')) return { data: { name: `projects/test-project/secrets/${id}/versions/7` } };
    throw new Error('Unexpected request');
  }) };
  const adapter = new GcpVariableDelivery({ project: 'test-project', region: 'europe-west9',
    runtimeServiceAccount: 'run@test-project.iam.gserviceaccount.com', transport,
    accessToken: jest.fn().mockResolvedValue('access-token') });
  const refs = await adapter.deliver(dep, { API_KEY: 'private-value' });
  expect(refs).toEqual([{ name: 'API_KEY', valueSource: { secretKeyRef: { secret: id, version: '7' } } }]);
  const calls = transport.request.mock.calls.map(([request]) => request);
  expect(calls.find(call => call.url.endsWith('/secrets') && call.method === 'POST').data.replication)
    .toEqual({ userManaged: { replicas: [{ location: 'europe-west9' }] } });
  expect(calls.find(call => call.url.endsWith(':setIamPolicy')).data.policy).toEqual({ bindings: [
    { role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:run@test-project.iam.gserviceaccount.com'] }], etag: 'etag-1' });
  expect(calls.find(call => call.url.endsWith(':addVersion')).data.payload.data)
    .toBe(Buffer.from('private-value').toString('base64'));
  expect(JSON.stringify(refs)).not.toContain('private-value');
});

test('refuses to replace a secret not owned by the portal', async () => {
  const transport = { request: jest.fn().mockResolvedValue({ data: { labels: { cnp_app: 'someone-else' } } }) };
  const adapter = new GcpVariableDelivery({ project: 'test-project', region: 'europe-west9',
    runtimeServiceAccount: 'run@test-project.iam.gserviceaccount.com', transport,
    accessToken: jest.fn().mockResolvedValue('access-token') });
  await expect(adapter.deliver(dep, { API_KEY: 'private-value' })).rejects.toThrow('hors du périmètre');
  expect(transport.request.mock.calls.some(([request]) => request.url.endsWith(':addVersion'))).toBe(false);
});

test('does not call Google for a deployment without variables', async () => {
  const accessToken = jest.fn();
  const adapter = new GcpVariableDelivery({ project: 'test-project', region: 'europe-west9',
    runtimeServiceAccount: 'run@test-project.iam.gserviceaccount.com', accessToken });
  expect(await adapter.deliver(dep, {})).toEqual([]);
  expect(accessToken).not.toHaveBeenCalled();
});
