'use strict';
jest.mock('../src/clients/secret-manager', () => ({ capability: jest.fn(), prepare: jest.fn(), store: jest.fn(), runtimeAccount: () => 'isolated@test-project.iam.gserviceaccount.com' }));
const service = require('../src/services/application-variables');
const provider = require('../src/clients/secret-manager');
const model = require('../src/models/deployment-environment');
const db = require('../src/models/db');
const dep = { id: 'variables-deployment', appName: 'sample', environment: 'dev', targetCluster: 'gcp' };
const ref = (name, version = '1') => ({ name, valueSource: { secretKeyRef: { secret: 'safe-secret', version } } });
beforeEach(() => {
  jest.clearAllMocks(); model.remove(dep.id); db.prepare('DELETE FROM deployment_configuration_locks').run();
  provider.capability.mockResolvedValue({ available: true }); provider.prepare.mockResolvedValue();
  provider.store.mockImplementation(async (_dep, name) => ref(name, '2'));
});
test('validates rows, empty values and explicit actions', () => {
  expect(service.parse({ variableName: ['TOKEN', 'EMPTY'], variableValue: ['private', ''], variableAction: ['set', 'set'] })).toHaveLength(2);
  expect(service.parse({})).toEqual([]);
});
test.each([
  { variableName: ['A', 'A'], variableValue: ['x', 'y'], variableAction: ['set', 'set'] },
  { variableName: 'PORT', variableValue: '3001', variableAction: 'set' },
  { variableName: 'BAD NAME', variableValue: 'private', variableAction: 'set' },
  { variableName: 'TOKEN', variableValue: 'private', variableAction: 'keep' },
  { variableName: 'TOKEN', variableValue: 'private', variableAction: 'unknown' },
  { variableName: 'TOKEN', variableValue: 'x'.repeat(32769), variableAction: 'set' },
  { variableName: 'TOKEN', variableValue: 'x\0y', variableAction: 'set' },
])('rejects invalid values without echoing their contents', body => {
  expect(() => service.parse(body)).toThrow();
  try { service.parse(body); } catch (error) { expect(error.message).not.toContain('private'); }
});
test('unavailable platform refuses provision before secret or identity creation', async () => {
  provider.capability.mockResolvedValue({ available: false, message: 'Platform not ready' });
  await expect(service.prepare(dep, [{ name: 'TOKEN', value: 'private', action: 'set' }])).rejects.toThrow('Platform not ready');
  expect(provider.prepare).not.toHaveBeenCalled(); expect(provider.store).not.toHaveBeenCalled(); expect(model.get(dep.id)).toEqual([]);
});
test('new values produce pinned metadata only, with no plaintext in SQLite', async () => {
  const config = await service.prepare(dep, [{ name: 'TOKEN', value: 'never-persist-this-value', action: 'set' }]);
  model.save(dep.id, config.refs, config);
  const row = db.prepare('SELECT * FROM deployment_environment_refs WHERE deployment_id=?').get(dep.id);
  expect(JSON.stringify(row)).not.toContain('never-persist-this-value');
  expect(model.get(dep.id)).toEqual([ref('TOKEN', '2')]); expect(model.metadata(dep.id).account).toBe('isolated@test-project.iam.gserviceaccount.com');
});
test('keep/remove do not require Google writes and deletion preserves the runtime account', async () => {
  model.save(dep.id, [ref('A'), ref('B')], { account: 'isolated@test-project.iam.gserviceaccount.com' });
  const result = await service.prepare(dep, [{ name: 'A', value: '', action: 'keep' }, { name: 'B', value: '', action: 'remove' }]);
  expect(result.refs).toEqual([ref('A')]); expect(result.removed).toEqual(['B']); expect(result.account).toBe('isolated@test-project.iam.gserviceaccount.com');
  expect(provider.capability).not.toHaveBeenCalled(); expect(provider.store).not.toHaveBeenCalled();
});
test('failed publication restores the previous snapshot and releases the lock', async () => {
  model.save(dep.id, [ref('A')]);
  await expect(service.update(dep, [{ name: 'A', value: 'private', action: 'set' }], async () => { throw new Error('CI failed'); })).rejects.toThrow('CI failed');
  expect(model.get(dep.id)).toEqual([ref('A')]); expect(model.busy(dep.id)).toBe(false);
});
test('concurrent edits are blocked and a stale worker cannot renew a new lease', async () => {
  const token = model.acquire(dep.id);
  await expect(service.update(dep, [], async () => {})).rejects.toThrow('déjà');
  db.prepare('UPDATE deployment_configuration_locks SET expires_at=0 WHERE deployment_id=?').run(dep.id);
  const replacement = model.acquire(dep.id);
  expect(() => model.renew(dep.id, token)).toThrow('expiré');
  model.release(dep.id, token); expect(model.busy(dep.id)).toBe(true); model.release(dep.id, replacement);
});
test('metadata permits an empty value but rejects any nonempty plaintext', () => {
  model.save(dep.id, [{ name: 'OPTIONAL', value: '' }]); expect(model.get(dep.id)).toEqual([{ name: 'OPTIONAL', value: '' }]);
  model.save(dep.id, [{ name: 'TOKEN', value: 'private' }]); expect(() => model.get(dep.id)).toThrow('invalides');
});
