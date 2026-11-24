'use strict';
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), operationalPackage: jest.fn(() => ({})) }));
jest.mock('child_process', () => ({ execFile: jest.fn(() => ({ stdin: { end() {} } })) }));
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');

test('à l’arrêt, une opération qui ne finit pas à temps est marquée échouée et reprenable, jamais laissée « running »', async () => {
  db.exec('DROP TABLE IF EXISTS failover_operations');
  profiles.profileFor.mockReturnValue({ profile: { gcp: { app_name: 'pilot' }, aws: { app_name: 'pilot' } }, secrets: { initialized: true } });
  const { id } = operations.start('pilot', 'health', { id: 'manager', role: 'manager' });
  await expect(operations.drain(20)).resolves.toEqual({ completed: 0, abandoned: 1 });
  const row = db.prepare('SELECT state,result FROM failover_operations WHERE id=?').get(id);
  expect(row.state).toBe('failed');
  expect(JSON.parse(row.result).error).toMatch(/Reprendre/);
});
