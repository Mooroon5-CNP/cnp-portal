'use strict';
jest.mock('../src/clients/google-access', () => ({ token: jest.fn(async () => 'access-token'), identity: jest.fn(async () => ({ kind: 'metadata', email: 'control@test-project.iam.gserviceaccount.com' })), headers: jest.fn(async () => ({ Authorization: 'Bearer access-token' })) }));
jest.mock('../src/clients/secret-manager', () => ({ prepare: jest.fn(), runtimeAccount: () => 'runtime@test-project.iam.gserviceaccount.com' }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn() }));
const protocol = require('../scripts/runtime/variables.cjs');
const provider = require('../src/clients/variable-bundles');
const github = require('../src/clients/github');
const identity = require('../src/clients/secret-manager');
const dep = { id: '11111111-1111-1111-1111-111111111111', appName: 'pixelcam', environment: 'dev', githubRepoUrl: 'https://github.com/team/pixel' };
beforeEach(() => {
  jest.clearAllMocks(); process.env.CNP_VARIABLES_PROVIDER = 'gcs';
  github.getInstallationOctokit.mockResolvedValue({ request: jest.fn(async () => ({ data: { content: Buffer.from('FROM node:20-alpine\nLABEL io.cnp.variables-contract="1"\n').toString('base64') } })) });
});
afterEach(() => { jest.restoreAllMocks(); delete process.env.CNP_VARIABLES_PROVIDER; });
test('creates only a private isolated bucket and grants its runtime read access', async () => {
  const calls = [];
  jest.spyOn(protocol, 'request').mockImplementation(async (url, args) => {
    calls.push([url, args]);
    if (url.endsWith('/iam') && args.method === 'PUT') return {};
    if (url.includes('/iam?')) return { etag: 'original-etag', bindings: [{ role: 'roles/storage.objectCreator', members: ['serviceAccount:control@test-project.iam.gserviceaccount.com'] }] };
    if (url.includes('?project=')) return args.body;
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  await provider.prepare(dep);
  const create = calls.find(([url]) => url.includes('?project='))[1].body;
  expect(create.name).toBe(provider.bucket(dep)); expect(create.iamConfiguration.publicAccessPrevention).toBe('enforced');
  const policy = calls.find(([, args]) => args.method === 'PUT')[1].body;
  expect(policy.etag).toBe('original-etag');
  expect(policy.bindings).toContainEqual({ role: 'roles/storage.objectViewer', members: ['serviceAccount:runtime@test-project.iam.gserviceaccount.com'] });
  expect(policy.bindings.flatMap(binding => binding.members)).not.toContain('allUsers');
  expect(identity.prepare).toHaveBeenCalledWith(dep, require('../src/clients/google-access'));
});
test('refuses an incompatible Dockerfile before IAM or bucket creation', async () => {
  github.getInstallationOctokit.mockResolvedValue({ request: async () => ({ data: { content: Buffer.from('FROM node:20-alpine\nCMD ["node", "app.js"]').toString('base64') } }) });
  const request = jest.spyOn(protocol, 'request');
  await expect(provider.prepare(dep)).rejects.toThrow('chargeur');
  expect(identity.prepare).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});
test('rejects a foreign or insufficiently private preexisting bucket', async () => {
  jest.spyOn(protocol, 'request').mockResolvedValue({ labels: { 'cnp-deployment': 'another-app' }, iamConfiguration: { publicAccessPrevention: 'inherited' } });
  await expect(provider.prepare(dep)).rejects.toThrow('privé');
});
test('application and environment scopes produce different buckets', () => {
  expect(provider.bucket(dep)).not.toBe(provider.bucket({ ...dep, environment: 'prod' }));
  expect(provider.bucket(dep)).not.toBe(provider.bucket({ ...dep, id: '22222222-2222-2222-2222-222222222222' }));
});
test('production bundles require an explicit operator activation after the pilot', async () => {
  const previous = process.env.CNP_VARIABLES_PRODUCTION_ENABLED; delete process.env.CNP_VARIABLES_PRODUCTION_ENABLED;
  try {
    await expect(provider.prepare({ ...dep, environment: 'prod' })).rejects.toThrow('pilote');
    expect(identity.prepare).not.toHaveBeenCalled();
  } finally { if (previous !== undefined) process.env.CNP_VARIABLES_PRODUCTION_ENABLED = previous; }
});
test('a label in a build stage cannot claim runtime compatibility for the final image', async () => {
  github.getInstallationOctokit.mockResolvedValue({ request: async () => ({ data: { content: Buffer.from('FROM node:20-alpine AS build\nLABEL io.cnp.variables-contract="1"\nFROM node:20-alpine\nCMD ["node", "app.js"]\n').toString('base64') } }) });
  await expect(provider.prepare(dep)).rejects.toThrow('chargeur');
  expect(identity.prepare).not.toHaveBeenCalled();
});
test('bucket errors retain safe status and operation for the operator diagnostic', async () => {
  jest.spyOn(protocol, 'request').mockRejectedValue({ status: 403, providerStatus: 'PERMISSION_DENIED', permission: 'storage.buckets.get', config: { data: 'private-payload' } });
  await expect(provider.prepare(dep)).rejects.toMatchObject({ status: 403, operation: 'storage.buckets.get', providerStatus: 'PERMISSION_DENIED', permission: 'storage.buckets.get' });
});
