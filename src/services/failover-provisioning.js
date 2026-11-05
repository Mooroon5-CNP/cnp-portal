'use strict';

// Durable initial provisioning. GitOps candidates still require their own manager review; this service never approves them.
// Aucun plan Terraform : l'infrastructure partagée vient de la pile plateforme, appliquée une fois par un humain.
const { randomUUID } = require('crypto');
const db = require('../models/db');
const profiles = require('./environment-failover');
const operations = require('./failover-operations');
const { isIntrospected } = require('./failover-profile');
// Le parcours d'une app : sans base, ou PostgreSQL en régime plateforme. Les profils historiques (le pilote) ne se remettent plus en
// service par ce parcours : ils n'avaient que des plans Terraform par app, retirés.
function stepsFor(document) {
  if (document.profile.mode === 'stateless') return STATELESS_STEPS;
  if (isIntrospected(document) && document.profile.automation?.regime === 'platform') return PLATFORM_STEPS;
  throw new Error('Profil historique : mise en service automatique retirée. Créer le profil de l’application en régime plateforme.');
}
const manager = user => {
  if (!user?.id || user.role !== 'manager') throw new Error('Validation manager requise.');
};
// Profil PostgreSQL du régime plateforme : le schéma se lit dans la base. Les rôles d'abord, puis l'application tourne sur GCP et
// crée son schéma, puis CNP le lit, le restaure sur la cible et s'abonne. Après les DNS (la sonde Route 53 existe), la publication
// « worker » déclare l'alarme et la configuration ; les déclencheurs de la plateforme sont déjà allumés, sans plan d'activation.
const PLATFORM_STEPS = [
  ['operation', 'initialize-secrets'],
  ['candidate', 'databases'], ['operation', 'observe'], ['operation', 'bootstrap-roles'],
  ['candidate', 'runtime'], ['operation', 'runtime-verify'], ['operation', 'schema-check'],
  ['operation', 'bootstrap'], ['operation', 'verify'],
  ['candidate', 'dns'], ['operation', 'observe'], ['candidate', 'worker'],
  ['operation', 'worker-configure'], ['operation', 'worker-verify'], ['operation', 'verify'],
  ['operation', 'worker-resume'], ['operation', 'health'],
];
const STATELESS_STEPS = [['candidate', 'runtime'], ['operation', 'runtime-verify'], ['candidate', 'dns'], ['operation', 'health']];
const WAITABLE = new Set(['observe', 'runtime-verify', 'health', 'schema-check']);
function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS failover_provisioning (
    app TEXT PRIMARY KEY, requested_by TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, reference TEXT, message TEXT, started_at TEXT NOT NULL,
    step_started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)`);
}
function get(app) {
  schema();
  return db.prepare('SELECT * FROM failover_provisioning WHERE app=?').get(app) || null;
}
function start(app, user) {
  manager(user); schema();
  const document = profiles.profileFor(app);
  if (!document) throw new Error('Configurer le profil de cette application avant sa mise en service.');
  const existing = get(app);
  if (existing) return existing;
  stepsFor(document);
  // Do not adopt an initialized database into a fresh bootstrap implicitly.
  if (operations.list(app).some(row => row.action === 'bootstrap') || profiles.rows(app).some(row => row.stage === 'dns' && row.state === 'published')) {
    throw new Error('Mise en service déjà engagée : conserver les étapes existantes et terminer leur vérification.');
  }
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO failover_provisioning
    (app,requested_by,state,started_at,step_started_at,updated_at) VALUES (?,?,'running',?,?,?)`)
    .run(app, user.id, now, now, now);
  return get(app);
}
function resume(app, user) {
  manager(user);
  const row = get(app);
  if (!row || row.state !== 'blocked') throw new Error('Aucune préparation bloquée à reprendre.');
  if (row.lease_until > Date.now()) throw new Error('Préparation encore en cours.');
  if (row.reference?.startsWith('operation:')) {
    const op = operations.list(app).find(value => value.id === row.reference.slice(10));
    if (op?.state === 'failed') {
      operations.retry(op.id, user);
      db.prepare("UPDATE failover_provisioning SET requested_by=?,state='running',message=NULL WHERE app=?").run(user.id, app);
      return get(app);
    }
  }
  const now = new Date().toISOString();
  db.prepare("UPDATE failover_provisioning SET requested_by=?,state='running',reference=NULL,message=NULL,step_started_at=?,updated_at=? WHERE app=?")
    .run(user.id, now, now, app);
  return get(app);
}
async function advance(app) {
  schema();
  const owner = randomUUID();
  if (!db.prepare(`UPDATE failover_provisioning SET lease_owner=?,lease_until=?
    WHERE app=? AND state IN ('running','review','waiting','completed') AND lease_until < ?`)
    .run(owner, Date.now() + 900000, app, Date.now()).changes) return;
  const save = (state, message, reference, next = false) => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE failover_provisioning SET state=?,message=?,reference=?,updated_at=?,
      step=step+?,step_started_at=CASE WHEN ? THEN ? ELSE step_started_at END
      WHERE app=? AND lease_owner=?`).run(state, message, reference || null, now, next ? 1 : 0, next ? 1 : 0, now, app, owner);
  };
  try {
    const row = get(app);
    const actor = db.prepare('SELECT id,role,active,approved FROM users WHERE id=?').get(row.requested_by);
    if (!actor || actor.role !== 'manager' || !actor.active || !actor.approved) throw new Error('Manager indisponible : un manager actif doit reprendre la préparation.');
    const document = profiles.profileFor(app);
    if (!document) throw new Error('Profil absent ; aucune ressource modifiée.');
    if (row.state === 'completed') {
      const health = operations.list(app).find(value => value.action === 'health');
      if (health && ['running', 'applying'].includes(health.state)) return;
      if (!health || Date.now() - Date.parse(health.created_at) >= 60000) operations.start(app, 'health', actor);
      return;
    }
    const steps = stepsFor(document);
    const step = steps[row.step];
    if (!step) { save('completed', 'Mise en service vérifiée. La surveillance assure désormais la bascule automatique.'); return; }
    const [kind, action] = step;
    if (kind === 'candidate') {
      const candidates = profiles.rows(app).filter(value => value.stage === action);
      let candidate = row.reference ? candidates.find(value => value.id === row.reference.slice(10))
        : candidates.find(value => ['pending', 'approving', 'published'].includes(value.state));
      if (!candidate) {
        const created = await profiles.prepare(action, actor, app);
        save('review', `Validation manager requise : ${action}.`, `candidate:${created.id}`);
      } else if (candidate.state === 'published') save('running', `${action} publié.`, null, true);
      else if (['pending', 'approving'].includes(candidate.state)) save('review', `Validation manager requise : ${action}.`, `candidate:${candidate.id}`);
      else throw new Error(`Proposition ${action} rejetée. Reprendre pour préparer un nouveau candidat.`);
      return;
    }
    if (action === 'worker-resume') {
      const verified = operations.list(app).find(value => value.action === 'verify' && value.state === 'completed');
      if (!verified || Date.now() - Date.parse(verified.created_at) > 540000) {
        // A long manager review must not activate with a stale SQL proof.
        const workerVerified = steps.findIndex(value => value[1] === 'worker-verify');
        db.prepare('UPDATE failover_provisioning SET step=?,reference=NULL,step_started_at=? WHERE app=? AND lease_owner=?')
          .run(steps.findIndex((value, index) => index > workerVerified && value[1] === 'verify'), new Date().toISOString(), app, owner);
        save('running', 'Nouvelle vérification de réplication avant activation.');
        return;
      }
    }
    let operation = row.reference ? operations.list(app).find(value => value.id === row.reference.slice(10))
      : operations.list(app).find(value => value.action === action && value.created_at >= row.step_started_at);
    if (!operation) {
      operation = operations.start(app, action, actor);
      save('running', `Préparation : ${action}.`, `operation:${operation.id}`);
      return;
    }
    const reference = `operation:${operation.id}`;
    if (operation.state === 'running') { save('running', `En cours : ${action}.`, reference); return; }
    const requiresProof = ['verify', 'runtime-verify', 'worker-verify', 'health', 'schema-check'].includes(action);
    // Une cause que le manager doit corriger (schéma non pris en charge) ne se rejoue pas : on l'affiche et on s'arrête.
    if (operation.state === 'failed' && operation.result?.action_required) throw new Error(operation.result.error);
    if (operation.state === 'completed' && (!requiresProof || operation.result?.verified === true)) {
      save('running', `${action} vérifié.`, null, true); return;
    }
    if (WAITABLE.has(action) && Date.now() - Date.parse(row.step_started_at) < 3600000) {
      // Read-only readiness checks can be repeated while providers converge.
      // A completed negative check starts a new observation; a failed check
      // reuses its durable operation, never a new SQL initialization.
      // Le message dit au manager quoi faire (ex. appeler l'application) : le lire sur la lecture qui vient de se terminer.
      const hint = operation.result?.message;
      if (operation.state === 'failed') operations.retry(operation.id, actor);
      else operation = operations.start(app, action, actor);
      save('waiting', hint || `Attente de disponibilité : ${action}.`, `operation:${operation.id}`); return;
    }
    throw new Error(operation.result?.error || `Étape ${action} non validée ; reprendre après correction.`);
  } catch (error) {
    const row = get(app);
    save('blocked', error.message, row.reference);
  } finally {
    db.prepare('UPDATE failover_provisioning SET lease_owner=NULL,lease_until=0 WHERE app=? AND lease_owner=?').run(app, owner);
  }
}
function startReconciler() {
  schema();
  operations.recoverInterrupted();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (const row of db.prepare("SELECT app FROM failover_provisioning WHERE state IN ('running','review','waiting','completed')").all()) await advance(row.app);
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick().catch(error => console.warn(error.message)), 30000);
  timer.unref();
  void tick().catch(error => console.warn(error.message));
  return timer;
}
module.exports = { get, start, resume, advance, startReconciler };
