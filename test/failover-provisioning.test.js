'use strict';
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), rows: jest.fn(), prepare: jest.fn() }));
jest.mock('../src/services/failover-operations', () => ({ list: jest.fn(), start: jest.fn(), retry: jest.fn(), recoverInterrupted: jest.fn() }));
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');
const workflow = require('../src/services/failover-provisioning');
const manager = { id: 'provision-manager', role: 'manager' };
let candidates, tasks, serial;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-04T17:00:00Z'));
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_provisioning');
  db.prepare(`INSERT OR REPLACE INTO users (id,username,role,active,approved,created_at,updated_at)
    VALUES (?,?,'manager',1,1,?,?)`).run(manager.id, manager.id, new Date().toISOString(), new Date().toISOString());
  candidates = []; tasks = []; serial = 0;
  profiles.profileFor.mockReturnValue({ profile: { gcp: {}, aws: {} } });
  profiles.rows.mockImplementation(app => candidates.filter(value => value.app === app));
  profiles.prepare.mockImplementation(async (stage, actor, app) => {
    const row = { id: `candidate-${++serial}`, app, stage, state: 'pending' };
    candidates.push(row); return row;
  });
  operations.list.mockImplementation(app => tasks.filter(value => value.app === app).slice().reverse());
  operations.start.mockImplementation((app, action) => {
    const row = { id: `operation-${++serial}`, app, action, state: 'running', created_at: new Date().toISOString() };
    tasks.push(row); return row;
  });
});
afterEach(() => jest.useRealTimers());
async function tick(app = 'weather-api') {
  jest.setSystemTime(Date.now() + 30000);
  await workflow.advance(app);
  return workflow.get(app);
}
function succeed() {
  const row = tasks.at(-1); row.state = 'completed'; row.result = { verified: true };
}
test('un développeur ne peut pas lancer de provisionnement', () => {
  expect(() => workflow.start('weather-api', { id: 'dev', role: 'dev' })).toThrow('manager');
  expect(operations.start).not.toHaveBeenCalled();
});
test('les plans et publications attendent leur revue, puis le parcours reprend sans doublon', async () => {
  workflow.start('weather-api', manager);
  await tick();
  tasks[0].state = 'review';
  expect((await tick()).state).toBe('review');
  await tick();
  expect(operations.start).toHaveBeenCalledTimes(1);
  succeed(); await tick();
  expect(workflow.get('weather-api').step).toBe(1);
  await tick(); succeed(); await tick();
  expect((await tick()).state).toBe('review');
  expect(candidates[0].stage).toBe('databases');
  await tick(); expect(profiles.prepare).toHaveBeenCalledTimes(1);
  candidates[0].state = 'published';
  await tick(); await tick();
  expect(tasks.at(-1).action).toBe('observe');
});
test('une initialisation SQL interrompue reprend le même identifiant et son journal', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=5 WHERE app=?').run('weather-api');
  await tick(); const id = tasks.at(-1).id;
  tasks.at(-1).state = 'failed';
  expect((await tick()).state).toBe('blocked');
  workflow.resume('weather-api', manager);
  expect(operations.retry).toHaveBeenCalledWith(id, manager);
  expect(workflow.get('weather-api').reference).toBe(`operation:${id}`);
});
test('un apply incertain impose un nouveau plan au lieu de rejouer apply', async () => {
  workflow.start('weather-api', manager);
  await tick(); Object.assign(tasks.at(-1), { state: 'failed', reviewed_by: manager.id });
  await tick(); workflow.resume('weather-api', manager); await tick();
  expect(operations.retry).not.toHaveBeenCalled();
  expect(operations.start).toHaveBeenCalledTimes(2);
  expect(tasks.at(-1).action).toBe('credentials-plan');
});
test('une preuve de réplication négative bloque avant toute activation', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=6 WHERE app=?').run('weather-api');
  await tick(); Object.assign(tasks.at(-1), { state: 'completed', result: { verified: false } });
  expect((await tick()).state).toBe('blocked');
  expect(tasks.map(value => value.action)).toEqual(['verify']);
});
test('les observations attendent la convergence, sans réinitialiser les bases', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=8 WHERE app=?').run('weather-api');
  await tick(); Object.assign(tasks.at(-1), { state: 'completed', result: { verified: false } });
  expect((await tick()).state).toBe('waiting');
  expect(tasks.map(value => value.action)).toEqual(['runtime-verify', 'runtime-verify']);
});
test('une revue longue renouvelle la preuve SQL et le plan avant activation', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=16 WHERE app=?').run('weather-api');
  expect((await tick()).step).toBe(14);
  await tick(); expect(tasks.at(-1).action).toBe('verify');
});
test('le parcours complet respecte les revues et ne se termine qu’après la preuve de santé', async () => {
  workflow.start('weather-api', manager);
  for (let index = 0; index < 60 && workflow.get('weather-api').state !== 'completed'; index++) {
    await tick();
    if (tasks.at(-1)?.state === 'running') succeed();
    if (candidates.at(-1)?.state === 'pending') candidates.at(-1).state = 'published';
  }
  expect(workflow.get('weather-api').state).toBe('completed');
  expect(tasks.map(value => value.action)).toEqual(['credentials-plan', 'initialize-secrets', 'observe', 'bootstrap-plan',
    'bootstrap', 'verify', 'runtime-verify', 'observe', 'automation-plan', 'worker-configure', 'worker-verify', 'verify', 'activation-plan', 'worker-resume', 'health']);
  expect(candidates.map(value => value.stage)).toEqual(['databases', 'runtime', 'dns']);
});
test('un manager révoqué ne poursuit pas une préparation et les autres applications sont isolées', async () => {
  workflow.start('weather-api', manager); workflow.start('another-api', manager);
  await tick();
  expect(workflow.get('another-api').reference).toBeNull();
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(manager.id);
  expect((await tick('another-api')).state).toBe('blocked');
  expect(operations.start).toHaveBeenCalledTimes(1);
});
test('une base déjà initialisée manuellement ne subit pas un nouveau bootstrap', () => {
  tasks.push({ app: 'weather-api', action: 'bootstrap', state: 'completed' });
  expect(() => workflow.start('weather-api', manager)).toThrow('déjà engagée');
});
test('la santé continue à être observée après la mise en service, sans rejouer les changements', async () => {
  workflow.start('weather-api', manager);
  db.prepare("UPDATE failover_provisioning SET state='completed' WHERE app=?").run('weather-api');
  await tick(); succeed();
  await tick(); expect(tasks).toHaveLength(1);
  await tick(); expect(tasks).toHaveLength(2);
  expect(tasks.map(value => value.action)).toEqual(['health', 'health']);
  expect(workflow.get('weather-api').state).toBe('completed');
});

describe('profil dont le schéma se lit dans la base', () => {
  const introspected = { profile: { gcp: { sql_contract: { database: 'appdb' } }, aws: {} } };
  const stepNumber = row => Number(row.id.split('-')[1]);
  beforeEach(() => profiles.profileFor.mockReturnValue(introspected));
  test('les rôles passent avant l’application, qui crée son schéma avant sa copie', async () => {
    workflow.start('weather-api', manager);
    for (let index = 0; index < 90 && workflow.get('weather-api').state !== 'completed'; index++) {
      await tick();
      if (tasks.at(-1)?.state === 'running') succeed();
      if (candidates.at(-1)?.state === 'pending') candidates.at(-1).state = 'published';
    }
    expect(workflow.get('weather-api').state).toBe('completed');
    expect(tasks.map(value => value.action)).toEqual(['credentials-plan', 'initialize-secrets', 'observe', 'bootstrap-plan',
      'bootstrap-roles', 'runtime-verify', 'schema-check', 'bootstrap', 'verify', 'observe', 'automation-plan', 'worker-configure',
      'worker-verify', 'verify', 'activation-plan', 'worker-resume', 'health']);
    expect(candidates.map(value => value.stage)).toEqual(['databases', 'runtime', 'dns']);
    const at = action => stepNumber(tasks.find(value => value.action === action));
    const runtime = stepNumber(candidates.find(value => value.stage === 'runtime'));
    expect(at('bootstrap-roles')).toBeLessThan(runtime);          // la cible a son rôle avant que l'application démarre
    expect(runtime).toBeLessThan(at('runtime-verify'));
    expect(at('runtime-verify')).toBeLessThan(at('schema-check'));
    expect(at('schema-check')).toBeLessThan(at('bootstrap'));      // le schéma existe avant d'être lu et copié
  });
  test('tant que l’application n’a pas créé son schéma, on attend en disant quoi faire, sans bloquer', async () => {
    workflow.start('weather-api', manager);
    db.prepare('UPDATE failover_provisioning SET step=8 WHERE app=?').run('weather-api');
    await tick();
    expect(tasks.at(-1).action).toBe('schema-check');
    Object.assign(tasks.at(-1), { state: 'completed', result: { verified: false, schema_ready: false, message: 'Aucune table : appeler l’application une fois.' } });
    const waiting = await tick();
    expect(waiting.state).toBe('waiting');
    expect(waiting.message).toContain('appeler l’application');
    expect(tasks.map(value => value.action)).toEqual(['schema-check', 'schema-check']);        // nouvelle lecture, pas une reprise
    Object.assign(tasks.at(-1), { state: 'completed', result: { verified: true } });
    await tick();
    expect(workflow.get('weather-api').step).toBe(9);
    await tick();
    expect(tasks.at(-1).action).toBe('bootstrap');
  });
  test('un schéma non pris en charge bloque avec la cause, sans être rejoué', async () => {
    workflow.start('weather-api', manager);
    db.prepare('UPDATE failover_provisioning SET step=8 WHERE app=?').run('weather-api');
    await tick();
    Object.assign(tasks.at(-1), { state: 'failed', result: { error: 'Schéma non pris en charge : billing.invoices.', action_required: true } });
    const blocked = await tick();
    expect(blocked.state).toBe('blocked');
    expect(blocked.message).toContain('billing.invoices');
    expect(operations.retry).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
  });
  test('une revue longue renouvelle la preuve de réplication au bon endroit du parcours', async () => {
    workflow.start('weather-api', manager);
    db.prepare('UPDATE failover_provisioning SET step=18 WHERE app=?').run('weather-api');
    expect((await tick()).step).toBe(16);
    await tick(); expect(tasks.at(-1).action).toBe('verify');
  });
});
