'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { execFile } = require('child_process');
const db = require('../models/db');
const service = require('./environment-failover');
const { isIntrospected } = require('./failover-profile');
const root = path.resolve(path.dirname(fs.realpathSync(__filename)), '../..');
const workRoot = path.join(root, 'data/failover-operations');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Plus aucun plan Terraform : l'infrastructure partagée est créée une fois par la pile plateforme, le propre à l'app passe par GitOps.
const actions = ['initialize-secrets', 'observe', 'bootstrap-roles', 'schema-check', 'bootstrap', 'verify', 'runtime-verify', 'worker-configure', 'worker-verify', 'worker-resume', 'health',
  'worker-pause', 'resync', 'runtime-rollout', 'schema-diff',
  // Retour manuel vers GCP (failover-provisioning, phase « failback ») : contrôle, verrou DNS, copie, reconstruction, réarmement.
  'failback-check', 'worker-failback-route', 'failback-sync', 'failback-reset', 'worker-rearm'];
const FAILBACK_SQL = ['failback-sync', 'failback-reset'];
// Suppression complète (failover-teardown) : libération, disparition des ressources, puis secrets et état du worker.
const TEARDOWN = ['teardown-released', 'teardown-gone', 'teardown-cleanup'];
const platformRegime = document => document.profile.automation?.regime === 'platform';
// Tâches ECS de la pile plateforme : leurs noms sont dans le profil.
const taskDefinition = (document, kind) => document.profile.automation?.[`${kind}_task_definition`] || null;
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
        if (error || result.error) {
          const failure = new Error(result.error || 'Opération refusée.');
          failure.actionRequired = result.action_required === true;
          return reject(failure);
        }
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
  if (!actions.includes(action) && !TEARDOWN.includes(action)) throw new Error('Opération inconnue.');
  const document = service.profileFor(app);
  if (TEARDOWN.includes(action)) {
    if (!document) throw new Error('Profil absent.');
    if (list(app).some(row => ['running', 'applying'].includes(row.state))) throw new Error('Une opération est déjà en cours.');
    const id = randomUUID();
    const request = { action, app, document, work: path.join(workRoot, id) };
    fs.mkdirSync(request.work, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(request.work, 'request.json'), JSON.stringify(request), { mode: 0o600 });
    db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run(id, app, action, 'running', hash(document), user.id, null, new Date().toISOString(), null);
    void finish(id, request);
    return { id, state: 'running' };
  }
  if (!document || (document.profile.mode === 'stateless' && !['health', 'runtime-verify', 'runtime-rollout'].includes(action))) throw new Error('Profil SQL requis.');
  if (list(app).some(row => ['running', 'applying'].includes(row.state))) throw new Error('Une opération est déjà en cours.');
  if (['bootstrap', 'bootstrap-roles'].includes(action) && !document.secrets.initialized) throw new Error('Initialisez d’abord les secrets.');
  if (['bootstrap-roles', 'schema-check'].includes(action) && !isIntrospected(document)) throw new Error('Étape réservée aux profils dont le schéma est lu dans la base.');
  // Le schéma se lit dans la base de l'application : elle doit tourner (et avoir créé ses tables) avant qu'on le copie.
  if (action === 'schema-check' && !previous(app, 'runtime-verify')?.result?.verified) throw new Error('Vérifier d’abord que l’application tourne sur GCP.');
  if (action === 'bootstrap' && isIntrospected(document)) {
    if (!previous(app, 'bootstrap-roles')) throw new Error('Préparer d’abord les rôles SQL de la cible.');
    if (!previous(app, 'schema-check')?.result?.verified) throw new Error('Le schéma de l’application doit exister sur la source : l’appeler une fois pour qu’elle crée ses tables.');
  }
  if (['verify', 'resync', 'schema-diff'].includes(action) && !previous(app, 'bootstrap')) throw new Error('Initialisation SQL non terminée.');
  if ((action === 'failback-check' || FAILBACK_SQL.includes(action) || ['worker-failback-route', 'worker-rearm'].includes(action))
    && (!platformRegime(document) || !isIntrospected(document))) throw new Error('Retour vers GCP réservé aux applications du régime plateforme.');
  if (['worker-configure', 'worker-verify'].includes(action) && !previous(app, 'verify')) throw new Error('Vérification de réplication requise.');
  if (action === 'worker-resume') {
    const verified = previous(app, 'verify');
    if (!previous(app, 'worker-verify') || !verified || Date.now() - Date.parse(verified.created_at) > 600000) throw new Error('Vérifications récentes de réplication et du worker requises avant activation.');
  }
  const id = randomUUID();
  const request = { action, app, document, work: path.join(workRoot, id) };
  // La seconde observation, après les DNS, doit aussi trouver les sondes Route 53 prêtes.
  // La troisième, après le worker, son alarme et sa configuration.
  if (action === 'observe') {
    const rows = service.rows(app);
    request.expect_probes = rows.some(row => row.stage === 'dns' && row.state === 'published');
    request.expect_worker = rows.some(row => row.stage === 'worker' && row.state === 'published');
  }
  if (['runtime-verify', 'runtime-rollout'].includes(action)) {
    service.rows(app);
    const runtime = db.prepare("SELECT image_record FROM failover_candidates WHERE app_name=? AND stage='runtime' AND state='published' ORDER BY created_at DESC LIMIT 1").get(app);
    if (!runtime) throw new Error('Publication des runtimes requise avant vérification.');
    request.images = runtime.image_record ? JSON.parse(runtime.image_record) : null;
  }
  if (action === 'health' && document.profile.mode !== 'stateless') {
    request.packages = service.operationalPackage(app, 'automation', user);
    request.task_definition = taskDefinition(document, 'worker');
  }
  if (['bootstrap', 'bootstrap-roles', 'schema-check', 'verify', 'resync', 'schema-diff', ...FAILBACK_SQL].includes(action)) {
    request.packages = service.operationalPackage(app, 'bootstrap', user);
    request.task_definition = taskDefinition(document, 'bootstrap');
    if (!request.task_definition) throw new Error('Tâche d’initialisation SQL absente : la pile plateforme doit être appliquée.');
  }
  if (action.startsWith('worker-')) {
    request.packages = service.operationalPackage(app, 'automation', user);
    request.task_definition = taskDefinition(document, 'worker');
    if (!request.task_definition) throw new Error('Tâche du worker absente : la pile plateforme doit être appliquée.');
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
    db.prepare('UPDATE failover_operations SET state=?,result=? WHERE id=?').run('completed', JSON.stringify(result), id);
  } catch (error) {
    db.prepare("UPDATE failover_operations SET state='failed',result=? WHERE id=?").run(
      JSON.stringify({ error: error.message, ...(error.actionRequired ? { action_required: true } : {}) }), id);
  }
}
async function createProfile(app, mode, contract, user) {
  manager(user);
  const deployments = require('../models/deployment');
  const row = deployments.listForUser(user).find(row => row.app_name === app && row.deployment_environment === 'prod');
  if (!row || row.target_cluster !== 'gcp') throw new Error('Déploiement de production GCP requis.');
  if (service.profileFor(app)) throw new Error('Ce déploiement possède déjà son profil.');
  // La plateforme crée la base des deux côtés et en transmet le nom à l'application (DB_NAME) : rien à demander au développeur.
  // Un nom fixe, car chaque application a sa propre instance ; un nom tiré de l'application pourrait tomber sur un nom réservé.
  if (mode === 'postgres' && contract == null) contract = { database: 'appdb' };
  if (mode === 'postgres') {
    if (contract && 'tables' in contract) throw new Error('Les tables ne se décrivent plus : elles sont lues dans la base de l’application. Indiquer seulement le nom de la base.');
    if (!contract || Object.keys(contract).join() !== 'database' || !/^[a-z][a-z0-9_]{0,62}$/.test(contract.database || '')) throw new Error('Nom de base invalide (minuscules, chiffres et _, 63 caractères au plus).');
  }
  const platform = service.platform();
  const template = mode === 'stateless' ? 'stateless' : mode === 'postgres' ? 'postgres' : null;
  if (!template) throw new Error('Choisir sans base ou PostgreSQL.');
  // Une app PostgreSQL neuve passe toujours par le régime plateforme (aucun plan Terraform par app) : ses tâches ECS doivent exister.
  if (mode === 'postgres' && !['bootstrap_task_definition', 'worker_task_definition'].every(key => platform.automation[key]))
    throw new Error('Paramètres de plateforme incomplets : automation.bootstrap_task_definition et automation.worker_task_definition (pile plateforme).');
  const configRepo = process.env.CNP_FAILOVER_CONFIG_REPO || path.resolve(root, '../config-repo');
  const profile = JSON.parse(fs.readFileSync(path.join(configRepo, `docs/templates/failover-phase1/${template}/recipe.example.json`)));
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
    profile.automation = { ...JSON.parse(JSON.stringify(platform.automation)), regime: 'platform' };
    // Le mot de passe administrateur de RDS est celui du Secret Kubernetes de l'application, pas un secret géré par RDS.
    profile.aws.master_password_secret = profile.gcp.credentials_secret_name;
    // Google bloque le nom d'une instance supprimée environ une semaine : une génération permet de redéployer aussitôt.
    profile.gcp.database_instance = `${app}-prod-gcp-db-${Date.now().toString(36)}`;
  }
  return service.configure(app, { profile, credentials: {}, secrets: { app }, observations: {} }, user);
}
function retry(id, user) {
  manager(user); schema();
  const row = db.prepare('SELECT * FROM failover_operations WHERE id=?').get(id);
  if (!row || row.state !== 'failed') throw new Error('Opération non disponible pour reprise.');
  const document = service.profileFor(row.app);
  if (hash(document) !== row.input_hash) throw new Error('Profil modifié ; préparer une nouvelle opération.');
  if (list(row.app).some(value => ['running', 'applying'].includes(value.state))) throw new Error('Opération déjà en cours.');
  const request = JSON.parse(fs.readFileSync(path.join(workRoot, id, 'request.json')));
  db.prepare("UPDATE failover_operations SET state='running',result=NULL WHERE id=?").run(id);
  void finish(id, request);
  return { id, state: 'running' };
}
function recoverInterrupted() {
  schema();
  db.prepare("UPDATE failover_operations SET state='failed',result=? WHERE state='running'")
    .run(JSON.stringify({ error: 'Portail redémarré pendant l’opération. Reprendre la tâche suivie.' }));
}
module.exports = { list, start, retry, createProfile, recoverInterrupted, run };
