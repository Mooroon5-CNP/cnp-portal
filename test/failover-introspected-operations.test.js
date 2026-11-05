'use strict';

// Initialisation SQL d'un profil dont le schéma se lit dans la base : l'ordre des opérations est imposé par des gardes, et
// une cause que le manager peut corriger lui est montrée telle quelle (une panne inconnue ne l'est jamais).
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), settings: jest.fn(), operationalPackage: jest.fn(), rows: jest.fn() }));
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));
const { execFile } = require('child_process');
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');

const user = { id: 'manager', role: 'manager' };
const app = 'weather-api';
const automation = { regime: 'platform', bootstrap_task_definition: 'cnp-failover-platform-bootstrap', worker_task_definition: 'cnp-failover-platform-worker' };
const introspected = { profile: { gcp: { app_name: app, sql_contract: { database: 'appdb' } }, aws: { app_name: app }, automation }, secrets: { initialized: true } };
const legacy = { profile: { gcp: { app_name: app, application_profile: 'pixelcalm' }, aws: { app_name: app } }, secrets: { initialized: true } };
let clock, requests;

function record(action, state, result = {}) {
  const at = new Date(Date.UTC(2026, 10, 5, 10, 0, 0) + (clock += 1000)).toISOString();
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run(`${action}-${clock}`, app, action, state, 'h', user.id, JSON.stringify(result), at, null);
}
const settled = async id => {
  for (let index = 0; index < 100; index++) {
    const row = operations.list(app).find(value => value.id === id);
    if (row && row.state !== 'running') return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('opération non terminée');
};

beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_operations');
  operations.list(app);                                   // recrée la table
  clock = 0; requests = [];
  profiles.profileFor.mockReturnValue(introspected);
  profiles.settings.mockReturnValue(null);
  profiles.operationalPackage.mockReturnValue({ 'bootstrap-config.json': {} });
  execFile.mockImplementation((command, args, options, callback) => ({
    stdin: { end: jest.fn(body => { requests.push(JSON.parse(body)); callback(null, JSON.stringify({ completed: true, verified: true })); }) },
  }));
});

test('les rôles et la lecture du schéma n’existent que pour un profil dont le schéma se lit dans la base', () => {
  profiles.profileFor.mockReturnValue(legacy);
  for (const action of ['bootstrap-roles', 'schema-check']) expect(() => operations.start(app, action, user)).toThrow('Étape réservée');
});

test('les rôles exigent des secrets initialisés', () => {
  profiles.profileFor.mockReturnValue({ ...introspected, secrets: { initialized: false } });
  expect(() => operations.start(app, 'bootstrap-roles', user)).toThrow('secrets');
});

test('on ne lit le schéma qu’une fois l’application vérifiée sur GCP', () => {
  expect(() => operations.start(app, 'schema-check', user)).toThrow('tourne sur GCP');
  record('runtime-verify', 'completed', { verified: false });
  expect(() => operations.start(app, 'schema-check', user)).toThrow('tourne sur GCP');
});

test('la copie du schéma exige les rôles préparés puis un schéma confirmé sur la source', () => {
  expect(() => operations.start(app, 'bootstrap', user)).toThrow('rôles SQL');
  record('bootstrap-roles', 'completed', { verified: false });
  expect(() => operations.start(app, 'bootstrap', user)).toThrow('doit exister sur la source');
  record('schema-check', 'completed', { verified: false, schema_ready: false });
  expect(() => operations.start(app, 'bootstrap', user)).toThrow('doit exister sur la source');
});

test('un profil historique autre que le pilote n’a plus de tâche d’initialisation (ses plans Terraform sont retirés)', () => {
  profiles.profileFor.mockReturnValue(legacy);
  expect(() => operations.start(app, 'bootstrap', user)).toThrow('pile plateforme');   // ni rôles ni lecture de schéma exigés
});

test('les tâches ECS viennent de la pile plateforme, sans plan préalable', async () => {
  record('runtime-verify', 'completed', { verified: true });
  await settled(operations.start(app, 'schema-check', user).id);
  record('verify', 'completed', { verified: true });
  await settled(operations.start(app, 'worker-verify', user).id);
  expect(requests.map(value => value.task_definition)).toEqual(['cnp-failover-platform-bootstrap', 'cnp-failover-platform-worker']);
});

test('une cause que le manager peut corriger est conservée jusqu’au résultat de l’opération', async () => {
  record('runtime-verify', 'completed', { verified: true });
  execFile.mockImplementation((command, args, options, callback) => ({
    stdin: { end: jest.fn(body => { requests.push(JSON.parse(body));
      callback(new Error('exit 1'), JSON.stringify({ error: 'Schéma non pris en charge : billing.invoices.', action_required: true })); }) },
  }));
  const { id } = operations.start(app, 'schema-check', user);
  const row = await settled(id);
  expect(requests[0]).toMatchObject({ action: 'schema-check', app, task_definition: 'cnp-failover-platform-bootstrap' });
  expect(row.state).toBe('failed');
  expect(row.result).toEqual({ error: 'Schéma non pris en charge : billing.invoices.', action_required: true });
});

test('une panne inconnue reste générique et n’est jamais présentée comme une action à faire', async () => {
  record('runtime-verify', 'completed', { verified: true });
  execFile.mockImplementation((command, args, options, callback) => ({
    stdin: { end: jest.fn(() => callback(new Error('exit 1'), JSON.stringify({ error: 'Opération interrompue ; vérifier les prérequis.' }))) },
  }));
  const row = await settled(operations.start(app, 'schema-check', user).id);
  expect(row.state).toBe('failed');
  expect(row.result.action_required).toBeUndefined();
});
