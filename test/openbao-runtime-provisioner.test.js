'use strict';

const { createHash } = require('crypto');
const { accountFor, ensureGcpIdentity } = require('../src/services/openbao-gcp-identity');
const { namesFor, ensureAzureIdentity } = require('../src/services/openbao-azure-identity');
const { authorized } = require('../src/services/openbao-runtime-provisioner-server');
const provisionerClient = require('../src/services/openbao-runtime-provisioner-client');

const dep = { appName: 'test-app', environment: 'dev', targetCluster: 'gcp' };
const missing = status => Object.assign(new Error('missing'), { response: { status } });

test('provisioner accepts only the portal KSA with the dedicated audience', async () => {
  const readFile = path => path.endsWith('/token') ? 'own-kubernetes-token' : Buffer.from('ca');
  const transport = { post: jest.fn(async () => ({ data: { status: { authenticated: true,
    user: { username: 'system:serviceaccount:cnp-portal:cnp-portal' },
    audiences: ['cnp-runtime-provisioner'] } } })) };
  await expect(authorized('portal-token', { transport, readFile })).resolves.toBe(true);
  expect(transport.post.mock.calls[0][1].spec).toEqual({ token: 'portal-token', audiences: ['cnp-runtime-provisioner'] });
  transport.post.mockResolvedValue({ data: { status: { authenticated: true,
    user: { username: 'system:serviceaccount:cnp-portal:other' }, audiences: ['cnp-runtime-provisioner'] } } });
  await expect(authorized('other-token', { transport, readFile })).resolves.toBe(false);
  transport.post.mockResolvedValue({ data: { status: { authenticated: true,
    user: { username: 'system:serviceaccount:cnp-portal:cnp-portal' }, audiences: ['kubernetes.default.svc'] } } });
  await expect(authorized('wrong-audience', { transport, readFile })).resolves.toBe(false);
});

test('portal calls the dedicated service and refuses an unconfirmed identity', async () => {
  const transport = { post: jest.fn().mockResolvedValue({ data: { ready: true } }) };
  const options = { address: 'http://provisioner.test:3001/', tokenFile: '/fake/token',
    readFile: () => 'portal-token', transport };
  await expect(provisionerClient.ensure(dep, options)).resolves.toBeUndefined();
  expect(transport.post).toHaveBeenCalledWith('http://provisioner.test:3001/ensure',
    { appName: 'test-app', environment: 'dev', targetCluster: 'gcp' },
    expect.objectContaining({ headers: { Authorization: 'Bearer portal-token' } }));
  transport.post.mockResolvedValue({ data: { ready: false } });
  await expect(provisionerClient.ensure(dep, options)).rejects.toThrow('non confirmée');
});

test('legacy deployments without provisioner keep their existing preflight', async () => {
  const transport = { post: jest.fn() };
  await expect(provisionerClient.ensure(dep, { address: '', transport })).resolves.toBeUndefined();
  expect(transport.post).not.toHaveBeenCalled();
});

test('runtime names are deterministic and differ across environments', () => {
  const dev = accountFor(dep, 'test-project-12345');
  const prod = accountFor({ ...dep, environment: 'prod' }, 'test-project-12345');
  expect(dev.email).not.toBe(prod.email);
  expect(dev.id).toBe(`cnp-${createHash('sha256').update('test-app/dev').digest('hex').slice(0, 20)}`);
  const azDev = namesFor(dep, '8e885538-8edd-4dd1-8e3c-64f1ae5ebc1e', 'cnp-shared');
  const azProd = namesFor({ ...dep, environment: 'prod' }, '8e885538-8edd-4dd1-8e3c-64f1ae5ebc1e', 'cnp-shared');
  expect(azDev.identity).not.toBe(azProd.identity);
  expect(azDev.vault).not.toBe(azProd.vault);
});

test('GCP provisioner creates a dedicated account and only expected IAM members', async () => {
  const account = accountFor(dep, 'test-project-12345');
  let serviceAccount;
  const policies = { service: { bindings: [], etag: 'service-etag' }, project: { bindings: [], etag: 'project-etag' } };
  const requests = [];
  const transport = { request: jest.fn(async ({ method, url, data }) => {
    requests.push({ method, url, data });
    if (url.endsWith(`/serviceAccounts/${account.email}`) && method === 'GET') {
      if (!serviceAccount) throw missing(404);
      return { data: serviceAccount };
    }
    if (url.endsWith('/serviceAccounts') && method === 'POST') {
      serviceAccount = { email: account.email, displayName: data.serviceAccount.displayName };
      return { data: serviceAccount };
    }
    if (url.includes(':getIamPolicy')) return { data: url.includes('cloudresourcemanager') ? policies.project : policies.service };
    if (url.includes(':setIamPolicy')) {
      const key = url.includes('cloudresourcemanager') ? 'project' : 'service';
      policies[key] = data.policy;
      return { data: policies[key] };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  const options = { project: 'test-project-12345', crossplaneServiceAccount: 'crossplane@test-project-12345.iam.gserviceaccount.com',
    transport, accessToken: async () => 'fake-token' };
  await expect(ensureGcpIdentity(dep, options)).resolves.toBe(account.email);
  expect(policies.service.bindings).toEqual([{ role: 'roles/iam.serviceAccountUser',
    members: ['serviceAccount:crossplane@test-project-12345.iam.gserviceaccount.com'] }]);
  expect(policies.project.bindings).toEqual([{ role: 'roles/cloudsql.client',
    members: [`serviceAccount:${account.email}`] }]);
  expect(requests.filter(item => item.url.includes(':getIamPolicy')).every(item =>
    item.data.options.requestedPolicyVersion === 3)).toBe(true);
  const firstCount = requests.length;
  await ensureGcpIdentity(dep, options);
  expect(requests.slice(firstCount).every(item => !['PUT', 'POST'].includes(item.method)
    || item.url.includes(':getIamPolicy'))).toBe(true);
});

test('GCP provisioner refuses an existing account with another owner label', async () => {
  const account = accountFor(dep, 'test-project-12345');
  const transport = { request: jest.fn(async () => ({ data: { email: account.email, displayName: 'Other owner' } })) };
  await expect(ensureGcpIdentity(dep, { project: 'test-project-12345',
    crossplaneServiceAccount: 'crossplane@test-project-12345.iam.gserviceaccount.com',
    transport, accessToken: async () => 'fake-token' })).rejects.toThrow('hors du périmètre');
});

test('Azure provisioner creates isolated resources and verifies role assignments', async () => {
  const subscription = '8e885538-8edd-4dd1-8e3c-64f1ae5ebc1e';
  const names = namesFor(dep, subscription, 'cnp-shared');
  const resources = new Map();
  const transport = { request: jest.fn(async ({ method, url, data }) => {
    if (method === 'GET' && url.includes('/roleDefinitions?')) {
      const roleName = decodeURIComponent(url).includes('Key Vault Secrets Officer')
        ? 'Key Vault Secrets Officer' : 'Key Vault Secrets User';
      return { data: { value: [{ id: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${roleName.split(' ').pop().toLowerCase()}`,
        properties: { roleName } }] } };
    }
    if (method === 'GET') {
      if (!resources.has(url)) throw missing(404);
      return { data: resources.get(url) };
    }
    if (method === 'PUT') {
      const value = url.includes('roleAssignments')
        ? { id: url.split('?')[0].replace('https://management.azure.com', ''), properties: data.properties }
        : { id: url.split('?')[0].replace('https://management.azure.com', ''), tags: data.tags,
          properties: url.includes('userAssignedIdentities')
            ? { principalId: '11111111-1111-4111-a111-111111111111' } : data.properties };
      resources.set(url, value);
      return { data: value };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  const options = { subscription, group: 'cnp-shared', location: 'francecentral',
    tenantId: '22222222-2222-4222-a222-222222222222', clientId: '33333333-3333-4333-a333-333333333333',
    portalPrincipalId: '44444444-4444-4444-a444-444444444444', tokenFile: '/fake', transport,
    accessToken: async () => 'fake-token' };
  await expect(ensureAzureIdentity(dep, options)).resolves.toEqual({ identity: names.identity, vault: names.vault });
  expect([...resources.keys()].filter(url => url.includes('/roleAssignments/'))).toHaveLength(2);
  const count = transport.request.mock.calls.length;
  await ensureAzureIdentity(dep, options);
  expect(transport.request.mock.calls.slice(count).every(([request]) => request.method === 'GET')).toBe(true);
});
