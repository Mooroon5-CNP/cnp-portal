'use strict';
jest.mock('../src/services/environment-failover', () => ({ profileFor: jest.fn(), rows: jest.fn(), prepare: jest.fn(), autoApprove: jest.fn() }));
jest.mock('../src/services/failover-operations', () => ({ list: jest.fn(), start: jest.fn(), retry: jest.fn(), recoverInterrupted: jest.fn() }));
const db = require('../src/models/db');
const profiles = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');
const workflow = require('../src/services/failover-provisioning');
const manager = { id: 'provision-manager', role: 'manager' };
// Profil PostgreSQL du régime plateforme (le seul parcours SQL) : schéma lu dans la base, aucun plan Terraform.
const platform = { profile: { gcp: { sql_contract: { database: 'appdb' } }, aws: {}, automation: { regime: 'platform' } } };
// Index des étapes du parcours plateforme, pour placer un test au bon endroit sans dépendre d'un numéro écrit à la main.
const STEPS = ['initialize-secrets', 'databases', 'observe', 'bootstrap-roles', 'runtime', 'runtime-verify', 'schema-check',
  'bootstrap', 'verify', 'dns', 'observe', 'worker', 'worker-configure', 'worker-verify', 'verify', 'worker-resume', 'health'];
const at = (name, after = -1) => STEPS.findIndex((value, index) => index > after && value === name);
let candidates, tasks, serial;
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-04T17:00:00Z'));
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_provisioning');
  db.prepare(`INSERT OR REPLACE INTO users (id,username,role,active,approved,created_at,updated_at)
    VALUES (?,?,'manager',1,1,?,?)`).run(manager.id, manager.id, new Date().toISOString(), new Date().toISOString());
  candidates = []; tasks = []; serial = 0;
  profiles.profileFor.mockReturnValue(platform);
  profiles.rows.mockImplementation(app => candidates.filter(value => value.app === app));
  // Comme le vrai prepare() : la proposition est enregistrée en attente, mais la valeur renvoyée n'a pas d'état.
  profiles.prepare.mockImplementation(async (stage, actor, app) => {
    const row = { id: `candidate-${++serial}`, app, stage, state: 'pending' };
    candidates.push(row); return { id: row.id, stage, prUrl: `https://example.test/pull/${serial}`, head: 'h'.repeat(40) };
  });
  delete process.env.CNP_FAILOVER_STEP_BY_STEP;
  // Approbation automatique : publie le candidat (les contrôles réels sont testés dans failover-environment.test.js).
  profiles.autoApprove.mockImplementation(async id => { candidates.find(value => value.id === id).state = 'published'; return { published: true }; });
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
test('un profil historique (plans Terraform par app) ne se met plus en service par ce parcours', () => {
  profiles.profileFor.mockReturnValue({ profile: { gcp: { application_profile: 'pixelcalm' }, aws: {} } });
  expect(() => workflow.start('weather-api', manager)).toThrow('régime plateforme');
  profiles.profileFor.mockReturnValue({ profile: { gcp: { sql_contract: { database: 'appdb' } }, aws: {}, automation: {} } });
  expect(() => workflow.start('weather-api', manager)).toThrow('régime plateforme');
  expect(operations.start).not.toHaveBeenCalled();
});
test('pas à pas (G5) : chaque publication attend la revue manager, puis le parcours reprend sans doublon', async () => {
  process.env.CNP_FAILOVER_STEP_BY_STEP = 'true';
  workflow.start('weather-api', manager);
  await tick();
  expect(tasks[0].action).toBe('initialize-secrets');
  await tick();
  expect(operations.start).toHaveBeenCalledTimes(1);                 // pas de second lancement pendant l'exécution
  succeed(); await tick();
  expect(workflow.get('weather-api').step).toBe(1);
  expect((await tick()).state).toBe('review');
  expect(candidates[0].stage).toBe('databases');
  await tick(); expect(profiles.prepare).toHaveBeenCalledTimes(1);
  candidates[0].state = 'published';
  await tick(); await tick();
  expect(tasks.at(-1).action).toBe('observe');
  expect(profiles.autoApprove).not.toHaveBeenCalled();
});
test('par défaut, une publication contrôlée s’approuve seule au nom du manager qui a lancé la mise en service', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('databases'), 'weather-api');
  const row = await tick();
  expect(row.state).toBe('running');
  expect(row.step).toBe(at('databases') + 1);
  expect(profiles.autoApprove).toHaveBeenCalledWith(candidates[0].id, expect.objectContaining({ id: manager.id, role: 'manager' }));
  expect(candidates[0].state).toBe('published');
});
test('un contrôle automatique en échec bloque avec sa raison, sans rien publier ni avancer', async () => {
  profiles.autoApprove.mockRejectedValue(new Error('Publication databases refusée par les contrôles automatiques : x.yaml sans deletionPolicy Orphan.'));
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('databases'), 'weather-api');
  const blocked = await tick();
  expect(blocked.state).toBe('blocked');
  expect(blocked.message).toContain('deletionPolicy Orphan');
  expect(blocked.step).toBe(at('databases'));
  expect(candidates[0].state).toBe('pending');
  workflow.resume('weather-api', manager);
  await tick();
  expect(profiles.prepare).toHaveBeenCalledTimes(1);                 // la même proposition est recontrôlée, pas une seconde
});
test('un verrou de publication occupé se réessaie au tour suivant sans bloquer', async () => {
  profiles.autoApprove.mockRejectedValueOnce(Object.assign(new Error('Publication déjà en cours.'), { retryable: true }));
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('databases'), 'weather-api');
  expect((await tick()).state).toBe('running');
  const next = await tick();
  expect(next.step).toBe(at('databases') + 1);
  expect(profiles.prepare).toHaveBeenCalledTimes(1);
});
test('une initialisation SQL interrompue reprend le même identifiant et son journal', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('bootstrap'), 'weather-api');
  await tick(); const id = tasks.at(-1).id;
  expect(tasks.at(-1).action).toBe('bootstrap');
  tasks.at(-1).state = 'failed';
  expect((await tick()).state).toBe('blocked');
  workflow.resume('weather-api', manager);
  expect(operations.retry).toHaveBeenCalledWith(id, manager);
  expect(workflow.get('weather-api').reference).toBe(`operation:${id}`);
});
test('une preuve de réplication négative bloque avant toute activation', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('verify'), 'weather-api');
  await tick(); Object.assign(tasks.at(-1), { state: 'completed', result: { verified: false } });
  expect((await tick()).state).toBe('blocked');
  expect(tasks.map(value => value.action)).toEqual(['verify']);
});
test('les observations attendent la convergence, sans réinitialiser les bases', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('runtime-verify'), 'weather-api');
  await tick(); Object.assign(tasks.at(-1), { state: 'completed', result: { verified: false } });
  expect((await tick()).state).toBe('waiting');
  expect(tasks.map(value => value.action)).toEqual(['runtime-verify', 'runtime-verify']);
});
test('une revue longue renouvelle la preuve SQL avant activation, au bon endroit du parcours', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('worker-resume'), 'weather-api');
  expect((await tick()).step).toBe(at('verify', at('worker-verify')));
  await tick(); expect(tasks.at(-1).action).toBe('verify');
});
test('le parcours complet, sans aucun plan ni revue manuelle, ne se termine qu’après la preuve de santé', async () => {
  workflow.start('weather-api', manager);
  const states = new Set();
  for (let index = 0; index < 90 && workflow.get('weather-api').state !== 'completed'; index++) {
    states.add((await tick()).state);
    if (tasks.at(-1)?.state === 'running') succeed();
  }
  expect(states.has('review')).toBe(false);                          // la seule décision humaine : la mise en service
  expect(profiles.autoApprove).toHaveBeenCalledTimes(4);
  expect(workflow.get('weather-api').state).toBe('completed');
  expect(tasks.map(value => value.action)).toEqual(['initialize-secrets', 'observe', 'bootstrap-roles', 'runtime-verify', 'schema-check',
    'bootstrap', 'verify', 'observe', 'worker-configure', 'worker-verify', 'verify', 'worker-resume', 'health']);
  expect(candidates.map(value => value.stage)).toEqual(['databases', 'runtime', 'dns', 'worker']);
  expect(tasks.some(value => value.action.endsWith('-plan'))).toBe(false);
  const order = name => Number((tasks.find(value => value.action === name) || candidates.find(value => value.stage === name)).id.split('-')[1]);
  expect(order('bootstrap-roles')).toBeLessThan(order('runtime'));        // la cible a son rôle avant que l'application démarre
  expect(order('runtime-verify')).toBeLessThan(order('schema-check'));
  expect(order('schema-check')).toBeLessThan(order('bootstrap'));         // le schéma existe avant d'être lu et copié
  expect(order('dns')).toBeLessThan(order('worker'));                     // la sonde Route 53 existe avant l'alarme
  expect(order('worker')).toBeLessThan(order('worker-configure'));        // la configuration est publiée avant d'être lue
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
test('tant que l’application n’a pas créé son schéma, on attend en disant quoi faire, sans bloquer', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('schema-check'), 'weather-api');
  await tick();
  expect(tasks.at(-1).action).toBe('schema-check');
  Object.assign(tasks.at(-1), { state: 'completed', result: { verified: false, schema_ready: false, message: 'Aucune table : appeler l’application une fois.' } });
  const waiting = await tick();
  expect(waiting.state).toBe('waiting');
  expect(waiting.message).toContain('appeler l’application');
  expect(tasks.map(value => value.action)).toEqual(['schema-check', 'schema-check']);        // nouvelle lecture, pas une reprise
  Object.assign(tasks.at(-1), { state: 'completed', result: { verified: true } });
  await tick();
  expect(workflow.get('weather-api').step).toBe(at('bootstrap'));
  await tick();
  expect(tasks.at(-1).action).toBe('bootstrap');
});
test('un schéma non pris en charge bloque avec la cause, sans être rejoué', async () => {
  workflow.start('weather-api', manager);
  db.prepare('UPDATE failover_provisioning SET step=? WHERE app=?').run(at('schema-check'), 'weather-api');
  await tick();
  Object.assign(tasks.at(-1), { state: 'failed', result: { error: 'Schéma non pris en charge : billing.invoices.', action_required: true } });
  const blocked = await tick();
  expect(blocked.state).toBe('blocked');
  expect(blocked.message).toContain('billing.invoices');
  expect(operations.retry).not.toHaveBeenCalled();
  expect(tasks).toHaveLength(1);
});
