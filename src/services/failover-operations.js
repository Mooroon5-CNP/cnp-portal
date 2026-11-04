'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { execFile } = require('child_process');
const db = require('../models/db');
const service = require('./environment-failover');
const root = path.resolve(path.dirname(fs.realpathSync(__filename)), '../..');
const workRoot = path.join(root, 'data/failover-operations');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actions = ['credentials-plan', 'bootstrap-plan', 'initialize-secrets', 'observe', 'bootstrap', 'verify', 'automation-plan', 'worker-configure', 'worker-verify', 'activation-plan', 'worker-resume', 'health'];
function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS failover_operations (id TEXT PRIMARY KEY, app TEXT NOT NULL,
    action TEXT NOT NULL, state TEXT NOT NULL, input_hash TEXT NOT NULL, requested_by TEXT NOT NULL,
    result TEXT, created_at TEXT NOT NULL, reviewed_by TEXT)`);
}
function list(app) {
  schema();
  return db.prepare('SELECT * FROM failover_operations WHERE app=? ORDER BY created_at DESC').all(app)
    .map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : null }));
}
function manager(user) {
  if (!user?.id || user.role !== 'manager') throw new Error('Validation manager requise.');
}
function run(request) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.CNP_FAILOVER_OPERATOR_PYTHON || process.env.CNP_FAILOVER_PYTHON || 'python3',
      [path.join(root, 'scripts/failover/operate.py')], { timeout: 1800000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        let result;
        try { result = JSON.parse(stdout); } catch (_) { return reject(new Error('Réponse opérateur indisponible.')); }
        if (error || result.error) return reject(new Error(result.error || 'Opération refusée.'));
        return resolve(result);
      });
    child.stdin.end(JSON.stringify(request));
  });
}
function previous(app, action) {
  return list(app).find(row => row.action === action && row.state === 'completed');
}
function start(app, action, user) {
  manager(user); schema();
  if (!actions.includes(action)) throw new Error('Opération inconnue.');
  const document = service.profileFor(app);
  if (!document || (document.profile.mode === 'stateless' && action !== 'health')) throw new Error('Profil SQL requis.');
  if (list(app).some(row => ['running', 'applying'].includes(row.state))) throw new Error('Une opération est déjà en cours.');
  const existingPilot = service.settings()?.app === app && document.secrets.initialized;
  if (existingPilot && ['bootstrap', 'worker-configure'].includes(action)) throw new Error('Pilote déjà initialisé : utiliser les vérifications, sans réinitialiser ses bases ou son worker.');
  if (action === 'bootstrap' && !document.secrets.initialized) throw new Error('Initialisez d’abord les secrets.');
  if (action === 'verify' && !existingPilot && !previous(app, 'bootstrap')) throw new Error('Initialisation SQL non terminée.');
  if (['automation-plan', 'worker-configure', 'worker-verify'].includes(action) && !previous(app, 'verify')) throw new Error('Vérification de réplication requise.');
  if (['activation-plan', 'worker-resume'].includes(action)) {
    const verified = previous(app, 'verify');
    if (!previous(app, 'worker-verify') || !verified || Date.now() - Date.parse(verified.created_at) > 600000) throw new Error('Vérifications récentes de réplication et du worker requises avant activation.');
  }
  if (action === 'worker-resume' && !previous(app, 'activation-plan')) throw new Error('Plan d’activation non appliqué.');
  const id = randomUUID();
  const request = { action, app, document, work: path.join(workRoot, id) };
  if (['bootstrap', 'verify'].includes(action)) {
    request.packages = service.operationalPackage(app, 'bootstrap', user);
    request.task_definition = previous(app, 'bootstrap-plan')?.result?.bootstrap_task_definition || (existingPilot ? 'cnp-failover-bootstrap' : null);
    if (!request.task_definition) throw new Error('Préparer et appliquer la tâche d’initialisation générique.');
  }
  if (action.startsWith('worker-') || ['bootstrap-plan', 'automation-plan', 'activation-plan'].includes(action)) {
    request.packages = service.operationalPackage(app, action === 'bootstrap-plan' ? 'bootstrap' : 'automation', user);
    request.task_definition = previous(app, 'activation-plan')?.result?.worker_task_definition || previous(app, 'automation-plan')?.result?.worker_task_definition || (existingPilot ? 'cnp-failover-automation' : null);
    if (action.startsWith('worker-') && !request.task_definition) throw new Error('Préparer et appliquer la tâche du worker.');
    if (['bootstrap-plan', 'automation-plan', 'activation-plan'].includes(action)) {
      const settings = service.settings();
      if (!settings?.bootstrapVariables) throw new Error('Varfile bootstrap partagé absent : ne pas omettre les ressources existantes.');
      const currentActivation = settings.activationVariables ? JSON.parse(fs.readFileSync(settings.activationVariables)) : {};
      if (!settings.automationVariables) throw new Error('Configuration existante du worker absente.');
      request.variables = { ...JSON.parse(fs.readFileSync(settings.bootstrapVariables)), ...JSON.parse(fs.readFileSync(settings.automationVariables)), ...currentActivation };
      request.kind = action;
      request.images = settings.images;
      if (!request.images) throw new Error('Images opérateur génériques non publiées.');
      request.action = 'automation-plan';

      if (action === 'activation-plan') request.variables.enable_triggers = true;

    }
  }
  fs.mkdirSync(request.work, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(request.work, 'request.json'), JSON.stringify(request), { mode: 0o600 });
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run(id, app, action, 'running', hash(document), user.id, null, new Date().toISOString(), null);
  void finish(id, request);
  return { id, state: 'running' };
}
async function finish(id, request) {
  try {
    const result = await run(request);
    if (hash(service.profileFor(request.app)) !== hash(request.document)) throw new Error('Le profil a changé pendant l’opération.');
    if (result.credentials || result.secrets || result.observations) {
      const document = JSON.parse(JSON.stringify(request.document));
      for (const key of ['credentials', 'secrets', 'observations']) if (result[key]) document[key] = result[key];
      if (result.source_ca) document.profile.gcp.gcp_runtime.database_ca_pem = result.source_ca;
      const actor = db.prepare('SELECT requested_by FROM failover_operations WHERE id=?').get(id);
      service.configure(request.app, document, { id: actor.requested_by, role: 'manager' });
    }
    db.prepare('UPDATE failover_operations SET state=?,result=? WHERE id=?').run(
      request.action.endsWith('-plan') && result.safe && result.changes.length ? 'review' : result.safe === false ? 'blocked' : 'completed', JSON.stringify(result), id);
  } catch (error) {
    db.prepare("UPDATE failover_operations SET state='failed',result=? WHERE id=?").run(JSON.stringify({ error: error.message }), id);
  }
}
function apply(id, user) {
  manager(user); schema();
  const row = db.prepare('SELECT * FROM failover_operations WHERE id=?').get(id);
  if (!row || row.state !== 'review') throw new Error('Plan non disponible pour approbation.');
  const document = service.profileFor(row.app);
  if (hash(document) !== row.input_hash) throw new Error('Profil modifié depuis la revue.');
  db.prepare("UPDATE failover_operations SET state='applying',reviewed_by=? WHERE id=?").run(user.id, id);
  void finish(id, { action: 'apply', app: row.app, document, work: path.join(workRoot, id) });
  return { id, state: 'applying' };
}
async function createProfile(app, mode, contract, user) {
  manager(user);
  const deployments = require('../models/deployment');
  const row = deployments.listForUser(user).find(row => row.app_name === app && row.deployment_environment === 'prod');
  if (!row || row.target_cluster !== 'gcp') throw new Error('Déploiement de production GCP requis.');
  if (service.profileFor(app)) throw new Error('Ce déploiement possède déjà son profil.');
  const settings = service.settings();
  if (!settings) throw new Error('Paramètres partagés de la plateforme absents.');
  const platform = service.inputs(settings).profile;
  const template = mode === 'stateless' ? 'stateless' : mode === 'postgres' ? 'postgres' : null;
  if (!template) throw new Error('Choisir sans base ou PostgreSQL.');
  const profile = JSON.parse(fs.readFileSync(path.resolve(root, `../config-repo/docs/templates/failover-phase1/${template}/recipe.example.json`)));
  const used = service.profiles().map(name => service.profileFor(name).profile.aws.listener_priority).filter(Number.isInteger);
  const id = randomUUID();
  const temporary = { profile: { gcp: { app_name: app }, aws: { app_name: app } } };
  const allocation = await run({ action: 'allocate-listener', app, document: temporary,
    work: path.join(workRoot, id), used_priorities: used });
  for (const side of ['gcp', 'aws']) { profile[side].app_name = app; profile[side].container_port = row.app_port || 8080; }
  profile.gcp.gcp_lb_ip = platform.gcp.gcp_lb_ip;
  profile.gcp.gcp_runtime.service_account = platform.gcp.gcp_runtime.service_account;
  profile.gcp.gcp_runtime.subnetwork = platform.gcp.gcp_runtime.subnetwork;
  profile.aws.listener_priority = allocation.priority;
  if (mode === 'postgres') {
    for (const side of ['gcp', 'aws']) { profile[side].database_name = contract.database; profile[side].sql_contract = contract; }
    profile.gcp.credentials_secret_name = `cnp-${app}-sql`;
    profile.aws.database_security_group_id = platform.aws.database_security_group_id;
    profile.aws.database_ca_pem = platform.aws.database_ca_pem;
    profile.automation = JSON.parse(JSON.stringify(platform.automation));
  }
  return service.configure(app, { profile, credentials: {}, secrets: { app }, observations: {} }, user);
}
module.exports = { list, start, apply, createProfile };
