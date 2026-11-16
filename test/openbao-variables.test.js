'use strict';

jest.mock('../src/models/deployment_variables', () => ({ get: jest.fn(), save: jest.fn() }));

const metadata = require('../src/models/deployment_variables');
const { service, validate, GENERATION_KEY } = require('../src/services/openbao-variables');

const deployment = { id: 'dep-1', appName: 'sample-app', environment: 'prod', targetCluster: 'gcp',
  failoverRequested: true, persistentStorage: false };

function fixture() {
  const stores = { gcp: { version: 0, values: null }, aws: { version: 0, values: null } };
  const clients = Object.fromEntries(Object.entries(stores).map(([domain, store]) => [domain, {
    read: jest.fn(async (_app, _environment, version) => {
      if (!store.version || (version && version !== store.version)) throw Object.assign(new Error('missing'), { status: 404 });
      return { version: store.version, values: { ...store.values } };
    }),
    write: jest.fn(async (_app, _environment, values, cas) => {
      if (cas !== store.version) throw new Error('CAS conflict');
      store.version += 1; store.values = { ...values }; return store.version;
    }),
    destroyVersion: jest.fn(async () => {}),
  }]));
  return { clients, stores, variables: service({ model: metadata, clientFor: domain => clients[domain], uuid: () => 'generation-1' }) };
}

beforeEach(() => jest.clearAllMocks());

test('writes and verifies the same generation on GCP and AWS before recording public metadata', async () => {
  const { clients, variables } = fixture();
  const result = await variables.prepare(deployment, { API_URL: 'https://example.test', FEATURE: 'on' });
  expect(result).toEqual({ generation: 'generation-1', names: ['API_URL', 'FEATURE'], versions: { gcp: 1, aws: 1 } });
  expect(clients.gcp.write).toHaveBeenCalledWith('sample-app', 'prod',
    { API_URL: 'https://example.test', FEATURE: 'on', [GENERATION_KEY]: 'generation-1' }, 0);
  expect(clients.aws.write).toHaveBeenCalledWith('sample-app', 'prod', expect.any(Object), 0);
  expect(metadata.save).toHaveBeenCalledWith(deployment.id, result);
  expect(JSON.stringify(metadata.save.mock.calls)).not.toContain('https://example.test');
});

test('a failed AWS write never publishes a partial generation', async () => {
  const { clients, variables } = fixture();
  clients.aws.write.mockRejectedValueOnce(new Error('AWS unavailable'));
  await expect(variables.prepare(deployment, { API_URL: 'https://example.test' })).rejects.toThrow('AWS unavailable');
  expect(metadata.save).not.toHaveBeenCalled();
  expect(clients.gcp.destroyVersion).toHaveBeenCalledWith('sample-app', 'prod', 1);
  expect(clients.aws.destroyVersion).not.toHaveBeenCalled();
});

test('a failed provisional cleanup is explicit and never publishes metadata', async () => {
  const { clients, variables } = fixture();
  clients.aws.write.mockRejectedValueOnce(new Error('AWS unavailable'));
  clients.gcp.destroyVersion.mockRejectedValueOnce(new Error('permission denied'));
  await expect(variables.prepare(deployment, { API_URL: 'https://example.test' }))
    .rejects.toThrow('nettoyage provisoire impossible dans gcp');
  expect(metadata.save).not.toHaveBeenCalled();
});

test('a failed update cleans the new version and preserves the version already published', async () => {
  const { clients, stores, variables } = fixture();
  stores.gcp.version = 1;
  stores.gcp.values = { API_URL: 'previous', [GENERATION_KEY]: 'previous-generation' };
  clients.aws.write.mockRejectedValueOnce(new Error('AWS unavailable'));
  await expect(variables.prepare(deployment, { API_URL: 'next' })).rejects.toThrow('AWS unavailable');
  expect(clients.gcp.destroyVersion).toHaveBeenCalledWith('sample-app', 'prod', 2);
  expect(clients.gcp.destroyVersion).not.toHaveBeenCalledWith('sample-app', 'prod', 1);
  expect(metadata.save).not.toHaveBeenCalled();
});

test('GCP without failover never accesses AWS and empty variables keep the old path', async () => {
  const { clients, variables } = fixture();
  const dev = { ...deployment, environment: 'dev', failoverRequested: false };
  expect(await variables.prepare(dev, {})).toBeNull();
  expect(clients.gcp.read).not.toHaveBeenCalled();
  await variables.prepare(dev, { FEATURE: 'on' });
  expect(clients.aws.read).not.toHaveBeenCalled();
  expect(clients.aws.write).not.toHaveBeenCalled();
});

test('an explicit empty update publishes a new generation without old variable names', async () => {
  const { clients, variables } = fixture();
  const result = await variables.prepare(deployment, {}, { allowEmpty: true });
  expect(result.names).toEqual([]);
  expect(clients.gcp.write).toHaveBeenCalledWith('sample-app', 'prod', { [GENERATION_KEY]: 'generation-1' }, 0);
  expect(clients.aws.write).toHaveBeenCalledWith('sample-app', 'prod', { [GENERATION_KEY]: 'generation-1' }, 0);
  expect(metadata.save).toHaveBeenCalledWith(deployment.id, result);
});

test('reads only the recorded versions and refuses a mismatched generation', async () => {
  const { clients, variables } = fixture();
  metadata.get.mockReturnValue({ generation: 'generation-1', names: ['API_URL'], versions: { gcp: 1, aws: 1 } });
  clients.gcp.read.mockResolvedValue({ version: 1, values: { API_URL: 'https://example.test', [GENERATION_KEY]: 'generation-1' } });
  clients.aws.read.mockResolvedValue({ version: 1, values: { API_URL: 'https://example.test', [GENERATION_KEY]: 'generation-1' } });
  expect((await variables.published(deployment)).values).toEqual({ gcp: { API_URL: 'https://example.test' },
    aws: { API_URL: 'https://example.test' } });
  clients.aws.read.mockResolvedValue({ version: 1, values: { API_URL: 'stale', [GENERATION_KEY]: 'other' } });
  await expect(variables.published(deployment)).rejects.toThrow('incohérente');
});

test('rejects reserved, malformed and non-string variables before OpenBao', () => {
  for (const values of [{ DB_PASSWORD: 'x' }, { PORT: '8080' }, { CNP_TOKEN: 'x' }, { 'BAD-NAME': 'x' },
    { FEATURE: 1 }]) expect(() => validate(values)).toThrow();
});
