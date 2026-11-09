'use strict';
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), operationalPackage: jest.fn() }));
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');
const user = { id: 'manager', role: 'manager' };
beforeEach(() => {
  db.exec('DROP TABLE IF EXISTS failover_operations');
  profiles.profileFor.mockReturnValue({ profile: { gcp: { app_name: 'pilot' }, aws: { app_name: 'pilot' } }, secrets: { initialized: true } });
});
test('un développeur ne peut ni exécuter ni reprendre une opération', () => {
  expect(() => operations.start('pilot', 'observe', { id: 'dev', role: 'dev' })).toThrow('manager');
  expect(() => operations.retry('missing', { id: 'dev', role: 'dev' })).toThrow('manager');
});
test('le portail ne lance plus aucun plan Terraform ni apply', () => {
  expect(operations.apply).toBeUndefined();
  for (const action of ['credentials-plan', 'bootstrap-plan', 'automation-plan', 'activation-plan', 'apply']) {
    expect(() => operations.start('pilot', action, user)).toThrow('inconnue');
  }
});
test('le worker nécessite une preuve de réplication et une opération inconnue est refusée', () => {
  expect(() => operations.start('other', 'worker-verify', user)).toThrow('réplication');
  expect(() => operations.start('other', 'delete', user)).toThrow('inconnue');
});
