'use strict';
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), settings: jest.fn(), operationalPackage: jest.fn() }));
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');
const user = { id: 'manager', role: 'manager' };
beforeEach(() => {
  db.exec('DROP TABLE IF EXISTS failover_operations');
  profiles.profileFor.mockReturnValue({ profile: { gcp: { app_name: 'pilot' }, aws: { app_name: 'pilot' } }, secrets: { initialized: true } });
  profiles.settings.mockReturnValue({ app: 'pilot' });
});
test('un développeur ne peut ni exécuter une opération ni approuver un apply', () => {
  expect(() => operations.start('pilot', 'observe', { id: 'dev', role: 'dev' })).toThrow('manager');
  expect(() => operations.apply('missing', { id: 'dev', role: 'dev' })).toThrow('manager');
});
test('le pilote déjà initialisé ne peut pas être réinitialisé', () => {
  expect(() => operations.start('pilot', 'bootstrap', user)).toThrow('déjà initialisé');
  expect(() => operations.start('pilot', 'worker-configure', user)).toThrow('déjà initialisé');
});
test('un plan non revu ou un profil changé interdit apply avant tout processus', () => {
  expect(() => operations.apply('missing', user)).toThrow('Plan non disponible');
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run('review', 'pilot', 'automation-plan', 'review', 'oldhash', user.id, '{}', new Date().toISOString(), null);
  expect(() => operations.apply('review', user)).toThrow('Profil modifié');
  expect(operations.list('pilot')[0].state).toBe('review');
});
test('le worker nécessite une preuve de réplication et une opération inconnue est refusée', () => {
  expect(() => operations.start('other', 'worker-verify', user)).toThrow('réplication');
  expect(() => operations.start('other', 'delete', user)).toThrow('inconnue');
});
