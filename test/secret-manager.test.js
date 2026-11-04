'use strict';
jest.mock('axios', () => ({ request: jest.fn() }));
jest.mock('../src/clients/google-access', () => ({ headers: jest.fn().mockResolvedValue({ Authorization: 'Bearer private-access-token' }), token: jest.fn().mockResolvedValue('private-access-token'), identity: jest.fn().mockResolvedValue({ kind: 'service_account', email: 'portal-platform@test-project.iam.gserviceaccount.com' }) }));
jest.mock('../src/config/env', () => ({ config: { gcp: { project: 'test-project' } } }));
const axios = require('axios');
const client = require('../src/clients/secret-manager');
const dep = { id: '11111111-1111-4111-8111-111111111111', appName: 'sample', environment: 'dev' };
beforeEach(() => axios.request.mockReset());
test('runtime identity is per deployment and only Crossplane can act as it', async () => {
  axios.request.mockImplementation(async options => {
    if (options.url.endsWith(':getIamPolicy')) return { data: { etag: 'keep-etag', bindings: [{ role: 'roles/viewer', members: ['user:operator@example.test'] }] } };
    return { data: {} };
  });
  await client.prepare(dep);
  expect(client.runtimeAccount(dep)).not.toBe(client.runtimeAccount({ ...dep, id: 'another' }));
  const policy = axios.request.mock.calls.find(([o]) => o.url.endsWith(':setIamPolicy'))[0].data.policy;
  expect(policy.etag).toBe('keep-etag'); expect(policy.bindings).toHaveLength(2);
  expect(policy.bindings[1]).toEqual({ role: 'roles/iam.serviceAccountUser', members: ['serviceAccount:crossplane-gcp-sa@test-project.iam.gserviceaccount.com'] });
});
test('secret payload is sent only to Secret Manager and references use numeric versions with isolated IAM', async () => {
  axios.request.mockImplementation(async options => {
    if (options.url.endsWith(':getIamPolicy')) return { data: { etag: 'old', bindings: [] } };
    if (options.url.endsWith(':addVersion')) return { data: { name: 'projects/test-project/secrets/generated/versions/7' } };
    return { data: { labels: { 'cnp-deployment': dep.id } } };
  });
  const ref = await client.store(dep, 'TOKEN', 'never-in-git');
  expect(ref.valueSource.secretKeyRef.version).toBe('7'); expect(JSON.stringify(ref)).not.toContain('never-in-git');
  const payload = axios.request.mock.calls.find(([o]) => o.url.endsWith(':addVersion'))[0].data;
  expect(Buffer.from(payload.payload.data, 'base64').toString()).toBe('never-in-git');
  const policy = axios.request.mock.calls.find(([o]) => o.url.endsWith(':setIamPolicy'))[0].data.policy;
  expect(policy.bindings[0].members).toEqual([`serviceAccount:${client.runtimeAccount(dep)}`]);
  expect(JSON.stringify(policy)).not.toContain('allUsers');
});
test('foreign ownership and IAM failure refuse the write and never expose Axios request data', async () => {
  axios.request.mockResolvedValue({ data: { labels: { 'cnp-deployment': 'other-deployment' } } });
  await expect(client.store(dep, 'TOKEN', 'private')).rejects.toThrow('Stockage');
  expect(axios.request).toHaveBeenCalledTimes(1);
  axios.request.mockRejectedValue(new Error('private-access-token and private payload'));
  try { await client.store(dep, 'TOKEN', 'private'); throw new Error('Expected failure'); }
  catch (error) { expect(error.message).not.toContain('private'); }
});

test('platform preflight reports missing permissions without provisioning resources', async () => {
  const post = jest.fn().mockResolvedValue({ data: { permissions: ['secretmanager.secrets.get'] } });
  axios.post = post;
  expect(await client.capability()).toMatchObject({ available: false, code: 'PLATFORM_PERMISSIONS_MISSING' });
  expect(post).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/cloudresourcemanager.googleapis.com\//), { permissions: client.REQUIRED_PERMISSIONS }, expect.any(Object));
  expect(axios.request).not.toHaveBeenCalled();
});
test('platform identity failures are safe and actionable', async () => {
  axios.post = jest.fn().mockRejectedValue(new Error('private-access-token'));
  const result = await client.capability();
  expect(result).toMatchObject({ available: false, code: 'PLATFORM_IDENTITY_UNAVAILABLE' });
  expect(JSON.stringify(result)).not.toContain('private');
});

test('preflight checks API activation as well as permissions', async () => {
  axios.post = jest.fn().mockResolvedValue({ data: { permissions: client.REQUIRED_PERMISSIONS } });
  axios.get = jest.fn().mockImplementation(async url => ({ data: url.includes('cloudresourcemanager') ? { projectNumber: '12345' } : { state: 'DISABLED' } }));
  expect(await client.capability()).toMatchObject({ available: false, code: 'PLATFORM_APIS_DISABLED' });
  axios.get.mockImplementation(async url => ({ data: url.includes('cloudresourcemanager') ? { projectNumber: '12345' } : { state: 'ENABLED' } }));
  expect(await client.capability()).toMatchObject({ available: true, code: 'READY' });
  expect(axios.get).toHaveBeenCalledWith('https://serviceusage.googleapis.com/v1/projects/12345/services/secretmanager.googleapis.com', expect.any(Object));
  expect(axios.request).not.toHaveBeenCalled();
});
test('production cannot enable secret management through an operator user login', async () => {
  const identity = require('../src/clients/google-access').identity; const previous = process.env.NODE_ENV;
  identity.mockResolvedValueOnce({ kind: 'authorized_user', email: null });
  try { process.env.NODE_ENV = 'production'; expect(await client.capability()).toMatchObject({ available: false, code: 'PLATFORM_DEDICATED_IDENTITY_REQUIRED' }); }
  finally { process.env.NODE_ENV = previous; }
});
test('the shared application identity cannot become the privileged portal identity', async () => {
  const settings = require('../src/config/env').config; const previous = settings.gcp.cloudRunSa;
  settings.gcp.cloudRunSa = 'portal-platform@test-project.iam.gserviceaccount.com'; axios.post = jest.fn();
  try { expect(await client.capability()).toMatchObject({ available: false, code: 'PLATFORM_DEDICATED_IDENTITY_REQUIRED' }); expect(axios.post).not.toHaveBeenCalled(); }
  finally { settings.gcp.cloudRunSa = previous; }
});

test('transient IAM propagation is retried without exposing secret payloads', async () => {
  jest.useFakeTimers(); let writes = 0;
  axios.request.mockImplementation(async options => {
    if (options.url.endsWith(':getIamPolicy')) return { data: { etag: 'keep', bindings: [] } };
    if (options.url.endsWith(':setIamPolicy') && writes++ === 0) throw { response: { status: 400, data: { error: { message: 'Service account does not exist yet' } } } };
    if (options.url.endsWith(':addVersion')) return { data: { name: 'projects/test-project/secrets/generated/versions/9' } };
    return { data: { labels: { 'cnp-deployment': dep.id } } };
  });
  try {
    const result = client.store(dep, 'TOKEN', 'private');
    await jest.advanceTimersByTimeAsync(1000);
    expect((await result).valueSource.secretKeyRef.version).toBe('9'); expect(writes).toBe(2);
  } finally { jest.useRealTimers(); }
});
test('empty values do not depend on zero-byte secret versions and never create plaintext nonempty values', async () => {
  expect(await client.store(dep, 'OPTIONAL', '')).toEqual({ name: 'OPTIONAL', value: '' });
  expect(axios.request).not.toHaveBeenCalled();
});

test('IAM policy read uses query options with an empty body and numeric ID after creation', async () => {
  let reads = 0;
  axios.request.mockImplementation(async options => {
    if (options.method === 'GET' && reads++ === 0) throw { response: { status: 404 } };
    if (options.method === 'POST' && options.url.endsWith('/serviceAccounts')) return { data: { uniqueId: '123456789012345678901' } };
    return { data: { bindings: [] } };
  });
  await client.prepare(dep);
  const get = axios.request.mock.calls.find(([options]) => options.url.endsWith(':getIamPolicy'))[0];
  expect(get.method).toBe('POST'); expect(get.data).toBeUndefined();
  expect(get.params).toEqual({ 'options.requestedPolicyVersion': 3 });
  expect(get.url).toContain('/123456789012345678901:getIamPolicy');
});
test('provisioning errors identify the failing IAM operation without exposing tokens or request data', async () => {
  axios.request.mockRejectedValue({ config: { headers: { Authorization: 'Bearer private-access-token' }, data: 'private-payload' }, response: { status: 403, data: { error: {
    status: 'PERMISSION_DENIED', message: 'private-payload', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED', metadata: { permission: 'iam.serviceAccounts.get', credential: 'private-access-token' } }],
  } } } });
  try { await client.prepare(dep); throw new Error('Expected failure'); }
  catch (error) {
    expect(error).toMatchObject({ status: 403, operation: 'iam.serviceAccounts.get', providerStatus: 'PERMISSION_DENIED', permission: 'iam.serviceAccounts.get' });
    expect(JSON.stringify(error)).not.toContain('private'); expect(error.message).not.toContain('private');
  }
});
