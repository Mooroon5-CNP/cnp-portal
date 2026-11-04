'use strict';
jest.mock('../src/clients/variable-bundles', () => ({ provider: () => 'gcs', capability: jest.fn(), prepare: jest.fn(), write: jest.fn(), read: jest.fn(), runtimeAccount: () => 'isolated@test-project.iam.gserviceaccount.com' }));
const provider = require('../src/clients/variable-bundles');
const service = require('../src/services/application-variables');
const model = require('../src/models/deployment-environment');
const dep = { id: '11111111-1111-1111-1111-111111111111', appName: 'pixelcam', targetCluster: 'gcp', environment: 'dev' };
const reference = { schemaVersion: 1, applicationId: dep.id, environment: 'dev', provider: 'gcs', bucket: 'cnp-vars-test', bundleId: '22222222-2222-2222-2222-222222222222', object: 'bundles/22222222-2222-2222-2222-222222222222.json', generation: '12' };
beforeEach(() => {
  jest.clearAllMocks(); model.remove(dep.id);
  provider.capability.mockResolvedValue({ available: true }); provider.prepare.mockResolvedValue();
  provider.write.mockImplementation(async (_dep, values) => ({ reference, names: Object.keys(values) }));
});
test('any compatible application prepares a bundle and persists references only', async () => {
  const config = await service.prepare(dep, [{ name: 'KEY', action: 'set', value: 'private-canary' }]);
  model.save(dep.id, config.refs, config);
  expect(model.bundle(dep.id)).toEqual({ reference, names: ['KEY'] });
  expect(service.names(dep.id)).toEqual(['KEY']);
  expect(JSON.stringify(config)).not.toContain('private-canary');
  expect(provider.prepare).toHaveBeenCalledWith(dep);
});
test('keep, replace and remove build a complete new snapshot without changing the old one', async () => {
  model.save(dep.id, [], { bundle: { reference, names: ['KEEP', 'REPLACE', 'DELETE'] } });
  provider.read.mockResolvedValue({ KEEP: 'old-keep', REPLACE: 'old-replace', DELETE: 'old-delete' });
  await service.prepare(dep, [{ name: 'KEEP', action: 'keep', value: '' }, { name: 'REPLACE', action: 'set', value: 'new' }, { name: 'DELETE', action: 'remove', value: '' }]);
  expect(provider.write).toHaveBeenCalledWith(dep, { KEEP: 'old-keep', REPLACE: 'new' });
  expect(model.bundle(dep.id).reference).toEqual(reference);
});
test('provider outage or CI failure leaves the prior persisted bundle available', async () => {
  const previous = { reference, names: ['KEY'] }; model.save(dep.id, [], { bundle: previous });
  provider.read.mockResolvedValue({ KEY: 'old' });
  await expect(service.update(dep, [{ name: 'KEY', action: 'set', value: 'new' }], async () => { throw new Error('CI failed'); })).rejects.toThrow('CI failed');
  expect(model.bundle(dep.id)).toEqual(previous); expect(model.busy(dep.id)).toBe(false);
});
