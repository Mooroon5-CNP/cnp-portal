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
  if (document.profile.mode === 'stateless') throw new Error('Failover sans base retiré le 08/11/2026 : seul le profil PostgreSQL existe (choix « GCP Cloud SQL » en prod).');
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
  // Argo CD lit Git toutes les ~3 min : sans cette observation, la configuration du worker partait 30 s après la fusion,
  // avant que sa configuration existe dans DynamoDB (constaté le 06/11/2026 en mode automatique).
  ['operation', 'observe'], ['operation', 'worker-configure'], ['operation', 'worker-verify'], ['operation', 'verify'],
  ['operation', 'worker-resume'], ['operation', 'health'],
];
// Mise à jour d'une app en service : une nouvelle CI de production réussie republie les runtimes GCP et AWS avec ses images
// (même publication contrôlée que la mise en service), puis vérifie que les deux côtés servent la nouvelle version.
// Avec une base : la migration de l'application a pu changer le schéma de GCP, que la réplication ne transporte pas. Le worker
// est mis en pause (aucune bascule vers une copie en reconstruction), la copie AWS est reconstruite si les schémas diffèrent,
// puis vérifiée avant la reprise du worker. Schéma inchangé (lecture seule « schema-diff ») : tout cela est sauté.
const SQL_UPDATE_STEPS = [['candidate', 'runtime'], ['operation', 'runtime-rollout'], ['operation', 'runtime-verify'], ['operation', 'schema-diff'], ['operation', 'worker-pause'], ['operation', 'resync'],
  ['operation', 'verify'], ['operation', 'worker-resume'], ['operation', 'health']];
// Retour manuel vers GCP, lancé par un manager quand le voyant « GCP disponible » est allumé (jamais automatique). Le worker
// est mis en pause et rouvre le verrou DNS de GCP (sans effet tant que GCP est fermé : sa sonde échoue) ; la copie AWS → GCP,
// vérifiée table par table, rouvre GCP et ferme AWS, et Route 53 rend le trafic à GCP de lui-même. La copie AWS est ensuite
// reconstruite depuis GCP (comme après une migration), puis le worker est réarmé et reprend la surveillance.
const FAILBACK_STEPS = [['operation', 'failback-check'], ['operation', 'worker-pause'], ['operation', 'worker-failback-route'],
  ['operation', 'failback-sync'], ['operation', 'failback-reset'], ['operation', 'verify'],
  ['operation', 'worker-rearm'], ['operation', 'worker-verify'], ['operation', 'verify'], ['operation', 'worker-resume'], ['operation', 'health']];

const UPDATE_CHECK_MS = 30000;
const lastUpdateCheck = new Map();
// worker-failback-route : un passage du worker commencé avant la pause garde son bail jusqu'à 2 min ; on réessaie.
const WAITABLE = new Set(['observe', 'runtime-rollout', 'runtime-verify', 'health', 'schema-check', 'worker-failback-route']);
// Une publication contrôlée s'approuve seule : la seule décision humaine reste l'approbation de production.
function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS failover_provisioning (
    app TEXT PRIMARY KEY, requested_by TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, reference TEXT, message TEXT, started_at TEXT NOT NULL,
    step_started_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)`);
  if (!db.pragma('table_info(failover_provisioning)').some(column => column.name === 'phase')) {
    db.exec('ALTER TABLE failover_provisioning ADD COLUMN phase TEXT');
  }
}
const stepsOf = (row, document) => row.phase === 'failback' ? FAILBACK_STEPS : row.phase !== 'update' ? stepsFor(document) : SQL_UPDATE_STEPS;
const PHASE_DONE = { update: 'Mise à jour déployée sur GCP et AWS ; secours vérifié.',
  failback: 'Application revenue sur GCP ; secours AWS reconstruit et surveillance rétablie.' };
// Révision de production à déployer, ou null : seulement sur une app saine que GCP sert (une mise à jour pendant que le
// secours AWS est actif attendra le retour sur GCP), au plus une lecture GitHub toutes les 2 min.
async function pendingRevision(app, health) {
  // Une app sans base n'a pas de worker (pas d'état) ; une app avec base doit être en surveillance, pas basculée.
  const watched = health?.result?.state;
  if (health?.state !== 'completed' || health.result?.verified !== true || (watched && watched !== 'WAIT_SIGNALS')) return null;
  if (Date.now() - (lastUpdateCheck.get(app) || 0) < UPDATE_CHECK_MS) return null;
  lastUpdateCheck.set(app, Date.now());
  try {
    const deployments = require('../models/deployment');
    const row = deployments.listForUser(null).find(value => value.app_name === app && value.deployment_environment === 'prod' && value.failover_requested);
    if (!row) return null;
    const { run } = await require('./failover-ci-images').latest(deployments.get(row.id));
    if (run.status !== 'completed' || run.conclusion !== 'success') return null;
    return run.head_sha !== profiles.runtimeRevision(app) ? run.head_sha : null;
  } catch (_) { return null; }                         // GitHub indisponible : on regarde au tour suivant
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
// Libellé lisible et durée habituelle (en secondes) de chaque étape, d'après les recettes du 06 au 08/11/2026 : un ordre de
// grandeur pour l'utilisateur, pas une limite. Une publication (« candidate ») attend la fusion puis la synchronisation Argo CD.
const STEP_INFO = {
  'candidate:databases': ['Publication des bases', 240], 'candidate:runtime': ['Publication de l’application sur GCP et AWS', 240],
  'candidate:dns': ['Publication du DNS', 240], 'candidate:worker': ['Publication de la surveillance', 240],
  'initialize-secrets': ['Création des secrets', 60], observe: ['Attente de la synchronisation Argo CD', 180],
  'bootstrap-roles': ['Création des rôles de base de données', 60], 'runtime-verify': ['Vérification de l’application sur GCP et AWS', 180],
  'runtime-rollout': ['Déploiement de la nouvelle version', 240], 'schema-check': ['Attente du schéma créé par l’application', 120],
  'schema-diff': ['Comparaison des schémas GCP et AWS', 60], bootstrap: ['Copie initiale de la base vers AWS', 180],
  verify: ['Vérification de la réplication', 60], 'worker-configure': ['Configuration de la surveillance', 60],
  'worker-verify': ['Vérification de la surveillance', 120], 'worker-pause': ['Pause de la surveillance', 60],
  'worker-resume': ['Reprise de la surveillance', 60], 'worker-rearm': ['Réarmement de la surveillance', 60],
  resync: ['Reconstruction de la copie AWS', 240], health: ['Contrôle de santé final', 120],
  'failback-check': ['Contrôle avant le retour', 60], 'worker-failback-route': ['Réouverture du DNS vers GCP', 120],
  'failback-sync': ['Copie AWS → GCP vérifiée et rouverture de GCP', 180], 'failback-reset': ['Reconstruction de la copie AWS depuis GCP', 240],
};
const stepInfo = ([kind, name]) => STEP_INFO[kind === 'candidate' ? `candidate:${name}` : name] || [name, 120];
// Avancement lisible d'une mise en service, pour la page de l'application (aucune action proposée) : étape en cours, temps
// écoulé et estimé (étape et parcours), et « long » quand l'étape dure plus du double de l'habitude.
function progress(app, now = Date.now()) {
  const row = get(app);
  if (!row) return null;
  let steps = null;
  try { steps = stepsOf(row, profiles.profileFor(app)); } catch (_) { /* profil absent ou historique */ }
  const value = { state: row.state, step: row.step, total: steps ? steps.length : null, message: row.message, phase: row.phase || 'provision' };
  if (!steps) return value;
  const current = steps[Math.min(row.step, steps.length - 1)];
  const [label, estimate] = stepInfo(current);
  const elapsed = Math.max(0, Math.round((now - Date.parse(row.step_started_at)) / 1000));
  const totalElapsed = Math.max(0, Math.round((now - Date.parse(row.started_at)) / 1000));
  // Reste estimé : le reste de l'étape en cours (au moins rien) plus les étapes suivantes.
  const remaining = Math.max(0, estimate - elapsed) + steps.slice(row.step + 1).reduce((sum, item) => sum + stepInfo(item)[1], 0);
  return { ...value, label, elapsed, estimate, totalElapsed, totalEstimate: totalElapsed + remaining, slow: elapsed > 2 * estimate };
}
// Voyant d'une app servie par AWS : le dernier contrôle de santé dit si GCP est revenu (lecture seule, aucune action).
function gcpStatus(app) {
  const health = operations.list(app).find(value => value.action === 'health' && value.state === 'completed');
  if (health?.result?.state !== 'AWS_ACTIVE') return null;
  const age = Date.now() / 1000 - (health.result.observed_at || 0);
  return { ...(health.result.gcp || { available: false, message: 'GCP indisponible.' }), fresh: age >= 0 && age < 180 };
}
function failback(app, user) {
  manager(user);
  const row = get(app);
  if (!row || row.state !== 'completed' || row.lease_until > Date.now()) throw new Error('Application pas en service ou opération en cours.');
  const status = gcpStatus(app);
  if (!status) throw new Error('L’application n’est pas servie par AWS : aucun retour à faire.');
  if (!status.available || !status.fresh) throw new Error(status.message || 'GCP indisponible.');
  const now = new Date().toISOString();
  db.prepare(`UPDATE failover_provisioning SET phase='failback',requested_by=?,step=0,state='running',reference=NULL,message=?,started_at=?,step_started_at=?,updated_at=?
    WHERE app=? AND state='completed' AND lease_until < ?`).run(user.id, 'Retour vers GCP demandé.', now, now, now, app, Date.now());
  return get(app);
}
function resume(app, user) {
  manager(user);
  const row = get(app);
  if (!row || row.state !== 'blocked') throw new Error('Aucune préparation bloquée à reprendre.');
  if (row.lease_until > Date.now()) throw new Error('Préparation encore en cours.');
  if (row.phase === 'update') {
    // Une mise à jour reprend depuis sa publication : la cause corrigée (générateur, image) doit être republiée, pas
    // seulement revérifiée. La nouvelle proposition naît après cet instant (voir le filtre des propositions en mise à jour).
    const now = new Date().toISOString();
    db.prepare("UPDATE failover_provisioning SET requested_by=?,state='running',step=0,reference=NULL,message=NULL,step_started_at=?,updated_at=? WHERE app=?")
      .run(user.id, now, now, app);
    return get(app);
  }
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
      const revision = await pendingRevision(app, health);
      if (revision) {
        const now = new Date().toISOString();
        db.prepare(`UPDATE failover_provisioning SET phase='update',step=0,state='running',reference=NULL,message=?,started_at=?,step_started_at=?,updated_at=?
          WHERE app=? AND lease_owner=?`).run(`Mise à jour vers ${revision.slice(0, 7)}.`, now, now, now, app, owner);
        return;
      }
      if (!health || Date.now() - Date.parse(health.created_at) >= 60000) operations.start(app, 'health', actor);
      return;
    }
    const steps = stepsOf(row, document);
    const step = steps[row.step];
    if (!step) {
      save('completed', PHASE_DONE[row.phase] || 'Mise en service vérifiée. La surveillance assure désormais la bascule automatique.');
      db.prepare('UPDATE failover_provisioning SET phase=NULL WHERE app=? AND lease_owner=?').run(app, owner);
      return;
    }
    const [kind, action] = step;
    if (kind === 'candidate') {
      // En mise à jour, seule une proposition née pendant cette étape compte : l'ancienne publication « runtime » est déjà là.
      const candidates = profiles.rows(app).filter(value => value.stage === action
        && (row.phase !== 'update' || value.created_at >= row.step_started_at));
      let candidate = row.reference ? candidates.find(value => value.id === row.reference.slice(10))
        : candidates.find(value => ['pending', 'approving', 'published'].includes(value.state));
      if (!candidate) {
        // prepare() renvoie la PR créée, pas son état : relire la proposition enregistrée (elle naît en attente).
        const created = await profiles.prepare(action, actor, app);
        candidate = profiles.rows(app).find(value => value.id === created.id);
        if (!candidate) throw new Error(`Proposition ${action} introuvable après sa préparation.`);
      }
      if (candidate.state === 'published') { save('running', `${action} publié.`, null, true); return; }
      if (!['pending', 'approving'].includes(candidate.state)) throw new Error(`Proposition ${action} rejetée. Reprendre pour préparer un nouveau candidat.`);
      await profiles.autoApprove(candidate.id, actor);
      // Argo CD relit Git tout de suite ; sans effet si l'Application n'existe pas encore (elle lira Git en naissant).
      require('../clients/kubernetes').refreshArgocdApplication(`${app}-prod`).catch(() => {});
      save('running', `${action} contrôlé et publié automatiquement.`, null, true);
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
    const requiresProof = ['failback-check', 'failback-sync', 'observe', 'verify', 'runtime-rollout', 'schema-diff', 'runtime-verify', 'worker-verify', 'health', 'schema-check'].includes(action);
    // Une cause que le manager doit corriger (schéma non pris en charge) ne se rejoue pas : on l'affiche et on s'arrête.
    if (operation.state === 'failed' && operation.result?.action_required) throw new Error(operation.result.error);
    if (operation.state === 'completed' && action === 'schema-diff' && operation.result?.verified === true && operation.result.changed === false) {
      // Mise à jour sans migration : pas de pause du worker ni de reconstruction, directement le contrôle de santé.
      db.prepare('UPDATE failover_provisioning SET step=?,reference=NULL,step_started_at=? WHERE app=? AND lease_owner=?')
        .run(steps.findIndex(value => value[1] === 'health'), new Date().toISOString(), app, owner);
      save('running', 'Schéma inchangé : aucune reconstruction.');
      return;
    }
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
    // Verrou de publication occupé : il se libère seul, on réessaie au tour suivant sans bloquer.
    if (error.retryable) { save(row.state, error.message, row.reference); return; }
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
      await require('./failover-teardown').tick();
    } finally { running = false; }
  };
  const timer = setInterval(() => void tick().catch(error => console.warn(error.message)), 30000);
  timer.unref();
  void tick().catch(error => console.warn(error.message));
  return timer;
}
module.exports = { get, start, resume, advance, startReconciler, progress, gcpStatus, failback };
