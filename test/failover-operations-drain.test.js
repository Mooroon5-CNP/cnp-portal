'use strict';
// Incident du 24/11/2026 : un contrôle de santé en vol sur l'ancien pod pendant un déploiement restait « running » pour
// toujours et gelait la surveillance de la bascule. Le portail doit le laisser finir, ou le libérer.
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), operationalPackage: jest.fn(() => ({})) }));
const callbacks = [];
jest.mock('child_process', () => ({ execFile: jest.fn((cmd, args, opts, cb) => { callbacks.push(cb); return { stdin: { end() {} } }; }) }));
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');
const user = { id: 'manager', role: 'manager' };
const state = id => db.prepare('SELECT state,result FROM failover_operations WHERE id=?').get(id);

beforeEach(() => {
  db.exec('DROP TABLE IF EXISTS failover_operations');
  callbacks.length = 0;
  profiles.profileFor.mockReturnValue({ profile: { gcp: { app_name: 'pilot' }, aws: { app_name: 'pilot' } }, secrets: { initialized: true } });
});

test('une opération stale sans processus est libérée ; une récente ou suivie ne l’est pas', () => {
  const { id } = operations.start('pilot', 'health', user);
  const row = { ...state(id), id, created_at: new Date(Date.now() - 600000).toISOString() };
  expect(operations.releaseStale(row, 300000)).toBe(false); // suivie par ce processus
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run('orphan', 'other', 'health', 'running', 'h', 'manager', null, new Date(Date.now() - 600000).toISOString(), null);
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run('fresh', 'other2', 'health', 'running', 'h', 'manager', null, new Date().toISOString(), null);
  const get = rowId => db.prepare('SELECT * FROM failover_operations WHERE id=?').get(rowId);
  expect(operations.releaseStale(get('fresh'), 300000)).toBe(false);
  expect(operations.releaseStale(get('orphan'), 300000)).toBe(true);
  expect(state('orphan').state).toBe('failed');
  callbacks[0](null, JSON.stringify({ verified: true }));
});

test('à l’arrêt, une opération en vol finit normalement, puis plus aucune ne démarre', async () => {
  const { id } = operations.start('pilot', 'health', user);
  const drained = operations.drain(5000);
  expect(() => operations.start('pilot2', 'health', user)).toThrow('redémarrage');
  callbacks[0](null, JSON.stringify({ verified: true }));
  await expect(drained).resolves.toEqual({ completed: 1, abandoned: 0 });
  expect(state(id).state).toBe('completed');
  expect(operations.isDraining()).toBe(true);
});
