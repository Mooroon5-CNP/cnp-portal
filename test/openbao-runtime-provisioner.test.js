'use strict';

const { createHash } = require('crypto');
const { accountFor, ensureGcpIdentity, removeGcpIdentity } = require('../src/services/openbao-gcp-identity');
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
    { appName: 'test-app', environment: 'dev', targetCluster: 'gcp', failoverRequested: false },
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

test('GCP provisioner waits for a new account to become visible to IAM', async () => {
  const account = accountFor(dep, 'test-project-12345');
  let serviceAccount;
  let invisible = 2;
  const policies = { service: { bindings: [] }, project: { bindings: [] } };
  const transport = { request: jest.fn(async ({ method, url, data }) => {
    if (url.endsWith(`/serviceAccounts/${account.email}`) && method === 'GET') {
      if (!serviceAccount) throw missing(404);
      return { data: serviceAccount };
    }
    if (url.endsWith('/serviceAccounts') && method === 'POST') {
      serviceAccount = { email: account.email, displayName: data.serviceAccount.displayName };
      return { data: serviceAccount };
    }
    if (url.includes(':getIamPolicy')) return { data: url.includes('cloudresourcemanager') ? policies.project : policies.service };
    if (url.includes('cloudresourcemanager') && url.includes(':setIamPolicy') && invisible > 0) {
      invisible -= 1;
      throw Object.assign(new Error('400'), { response: { status: 400,
        data: { error: { message: `Exception calling IAM: Service account ${account.email} does not exist.` } } } });
    }
    if (url.includes(':setIamPolicy')) {
      policies[url.includes('cloudresourcemanager') ? 'project' : 'service'] = data.policy;
      return { data: data.policy };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  const sleep = jest.fn(async () => {});
  await expect(ensureGcpIdentity(dep, { project: 'test-project-12345',
    crossplaneServiceAccount: 'crossplane@test-project-12345.iam.gserviceaccount.com',
    transport, accessToken: async () => 'fake-token', sleep })).resolves.toBe(account.email);
  expect(sleep).toHaveBeenCalledTimes(2);
  expect(policies.project.bindings).toEqual([{ role: 'roles/cloudsql.client', members: [`serviceAccount:${account.email}`] }]);
});

test('GCP provisioner does not retry other HTTP 400 errors', async () => {
  const account = accountFor(dep, 'test-project-12345');
  const transport = { request: jest.fn(async ({ method, url }) => {
    if (url.endsWith(`/serviceAccounts/${account.email}`) && method === 'GET') {
      return { data: { email: account.email, displayName: account.displayName } };
    }
    if (url.includes(':getIamPolicy')) return { data: { bindings: [] } };
    throw Object.assign(new Error('400'), { response: { status: 400, data: { error: { message: 'Invalid argument.' } } } });
  }) };
  const sleep = jest.fn(async () => {});
  await expect(ensureGcpIdentity(dep, { project: 'test-project-12345',
    crossplaneServiceAccount: 'crossplane@test-project-12345.iam.gserviceaccount.com',
    transport, accessToken: async () => 'fake-token', sleep })).rejects.toThrow('HTTP 400');
  expect(sleep).not.toHaveBeenCalled();
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
      // Mirrors Azure: an explicit enablePurgeProtection=false is rejected with HTTP 400 (seen live on 2026-11-23).
      if (url.includes('/Microsoft.KeyVault/vaults/') && !url.includes('roleAssignments')
        && data.properties?.enablePurgeProtection === false) throw missing(400);
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

test('Azure removal deletes only the app vault and identity it created, and tolerates an absent one', async () => {
  const { removeAzureIdentity } = require('../src/services/openbao-azure-identity');
  const subscription = '8e885538-8edd-4dd1-8e3c-64f1ae5ebc1e';
  const azureDep = { ...dep, targetCluster: 'azure' };
  const names = namesFor(azureDep, subscription, 'cnp-runtime');
  const tags = { cnp_environment: 'test-app/dev', cnp_owner: 'openbao_runtime_provisioner' };
  const existing = new Map([[names.vault, { id: names.vault, tags }], [names.identity, { id: names.identity, tags }]]);
  const calls = [];
  const transport = { request: jest.fn(async ({ method, url }) => {
    const path = url.replace('https://management.azure.com', '').split('?')[0];
    calls.push(`${method} ${path.split('/').slice(-2).join('/')}`);
    if (method === 'GET') { if (!existing.has(path)) throw missing(404); return { data: existing.get(path) }; }
    if (method === 'DELETE') { existing.delete(path); return { data: {} }; }
    if (method === 'POST' && path.endsWith('/purge')) throw missing(403); // droit d'abonnement absent : purge différée
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  const options = { subscription, group: 'cnp-runtime', location: 'francecentral', tenantId: '22222222-2222-4222-a222-222222222222',
    clientId: '33333333-3333-4333-a333-333333333333', tokenFile: '/fake', transport, accessToken: async () => 'fake-token' };
  await expect(removeAzureIdentity(azureDep, options)).resolves.toEqual({ vault: true, purged: false, identity: true });
  expect(existing.size).toBe(0);
  expect(calls.filter(call => call.startsWith('DELETE'))).toHaveLength(2);
  await expect(removeAzureIdentity(azureDep, options)).resolves.toEqual({ vault: false, purged: false, identity: false });
  existing.set(names.vault, { id: names.vault, tags: { ...tags, cnp_environment: 'other-app/dev' } });
  await expect(removeAzureIdentity(azureDep, options)).rejects.toThrow('hors du périmètre');
  expect(existing.has(names.vault)).toBe(true);
});

test('Azure ensure recovers its own soft-deleted vault when an app is recreated within 7 days', async () => {
  const subscription = '8e885538-8edd-4dd1-8e3c-64f1ae5ebc1e';
  const azureDep = { ...dep, targetCluster: 'azure' };
  const names = namesFor(azureDep, subscription, 'cnp-runtime');
  const resources = new Map();
  const transport = { request: jest.fn(async ({ method, url, data }) => {
    const path = url.replace('https://management.azure.com', '').split('?')[0];
    if (method === 'GET' && url.includes('/roleDefinitions?')) {
      const roleName = decodeURIComponent(url).includes('Officer') ? 'Key Vault Secrets Officer' : 'Key Vault Secrets User';
      return { data: { value: [{ id: `/subscriptions/${subscription}/providers/Microsoft.Authorization/roleDefinitions/${roleName.length}`, properties: { roleName } }] } };
    }
    if (method === 'GET') { if (!resources.has(path)) throw missing(404); return { data: resources.get(path) }; }
    if (method === 'PUT') {
      if (path === names.vault && data.properties.createMode !== 'recover') throw missing(409); // nom réservé par le coffre supprimé
      const value = { id: path, tags: data.tags, properties: path.includes('userAssignedIdentities')
        ? { principalId: '11111111-1111-4111-a111-111111111111' } : data.properties };
      resources.set(path, value); return { data: value };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const pending = ensureAzureIdentity(azureDep, { subscription, group: 'cnp-runtime', location: 'francecentral',
    tenantId: '22222222-2222-4222-a222-222222222222', clientId: '33333333-3333-4333-a333-333333333333',
    portalPrincipalId: '44444444-4444-4444-a444-444444444444', tokenFile: '/fake', transport, accessToken: async () => 'fake-token' });
  for (let i = 0; i < 30; i += 1) await jest.advanceTimersByTimeAsync(1000);
  jest.useRealTimers();
  await expect(pending).resolves.toEqual({ identity: names.identity, vault: names.vault });
  expect(resources.get(names.vault).properties.createMode).toBe('recover');
});

test('portal asks the provisioner to remove GCP and Azure runtime identities', async () => {
  const transport = { post: jest.fn().mockResolvedValue({ data: { removed: true, aws: true, gcp: true } }) };
  const options = { address: 'http://provisioner.test:3001', tokenFile: '/fake/token', readFile: () => 'portal-token', transport };
  const prod = { ...dep, environment: 'prod', failoverRequested: true };
  await expect(provisionerClient.remove(prod, options)).resolves.toEqual({ removed: true, aws: true, gcp: true });
  expect(transport.post).toHaveBeenCalledWith('http://provisioner.test:3001/remove',
    { appName: 'test-app', environment: 'prod', targetCluster: 'gcp', failoverRequested: true },
    expect.objectContaining({ headers: { Authorization: 'Bearer portal-token' } }));
  await expect(provisionerClient.remove({ ...dep, targetCluster: 'private-aws' }, options)).resolves.toBeNull();
  await expect(provisionerClient.remove(dep, { ...options, address: '' })).resolves.toBeNull();
  expect(transport.post).toHaveBeenCalledTimes(1);
  await provisionerClient.remove({ ...dep, targetCluster: 'azure' }, options);
  expect(transport.post.mock.calls[1][1]).toMatchObject({ targetCluster: 'azure' });
  transport.post.mockResolvedValue({ data: {} });
  await expect(provisionerClient.remove(dep, options)).rejects.toThrow('non confirmée');
});

test('GCP removal deletes only the dedicated account and its project bindings', async () => {
  const account = accountFor(dep, 'test-project-12345');
  const other = 'serviceAccount:other@test-project-12345.iam.gserviceaccount.com';
  let policy = { etag: 'e', bindings: [
    { role: 'roles/cloudsql.client', members: [`serviceAccount:${account.email}`, other] },
    { role: 'roles/logging.logWriter', members: [`deleted:serviceAccount:${account.email}?uid=123`] },
    { role: 'roles/viewer', members: [other], condition: { title: 'kept' } }] };
  let present = true;
  const calls = [];
  const transport = { request: jest.fn(async ({ method, url, data }) => {
    calls.push(`${method} ${url.split('/').pop()}`);
    if (url.endsWith(account.email) && method === 'GET') {
      if (!present) throw missing(404);
      return { data: { email: account.email, displayName: account.displayName } };
    }
    if (url.endsWith(account.email) && method === 'DELETE') { present = false; return { data: {} }; }
    if (url.includes(':getIamPolicy')) return { data: policy };
    if (url.includes(':setIamPolicy')) { policy = data.policy; return { data: policy }; }
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  const options = { project: 'test-project-12345', transport, accessToken: async () => 'fake-token' };
  await expect(removeGcpIdentity(dep, options)).resolves.toBe(true);
  expect(policy.bindings).toEqual([{ role: 'roles/cloudsql.client', members: [other] },
    { role: 'roles/viewer', members: [other], condition: { title: 'kept' } }]);
  expect(calls.indexOf('POST test-project-12345:setIamPolicy')).toBeLessThan(calls.indexOf(`DELETE ${account.email}`));
  calls.length = 0;
  await expect(removeGcpIdentity(dep, options)).resolves.toBe(false);           // déjà supprimé : aucune écriture
  expect(calls.some(call => call.startsWith('DELETE') || call.includes(':setIamPolicy'))).toBe(false);
});

test('GCP removal refuses an account it did not create', async () => {
  const account = accountFor(dep, 'test-project-12345');
  const transport = { request: jest.fn(async ({ method, url }) => {
    if (method === 'GET' && url.endsWith(account.email)) return { data: { email: account.email, displayName: 'someone else' } };
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  await expect(removeGcpIdentity(dep, { project: 'test-project-12345', transport, accessToken: async () => 'fake-token' }))
    .rejects.toThrow('hors du périmètre');
  expect(transport.request).toHaveBeenCalledTimes(1);
});
