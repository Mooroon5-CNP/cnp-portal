'use strict';

// Profil opt-in de phase 1, séparé du parcours Azure de Maia. Les fichiers sont
// générés depuis la baseline Git distante et publiés uniquement par la GitHub
// App, après revue manager du contenu exact. Aucun apply cloud dans ce module.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const yaml = require('js-yaml');
const db = require('../models/db');
const { config } = require('../config/env');
const github = require('../clients/github');
const sourceRoot = path.resolve(path.dirname(fs.realpathSync(__filename)), '../..');

const STAGES = ['databases', 'runtime', 'dns'];
// Régime « plateforme » : l'alarme et la configuration du worker sont publiées par GitOps, après les DNS (la sonde Route 53 doit exister).
const PLATFORM_STAGES = [...STAGES, 'worker'];
function stagesFor(document) {
  if (document.profile.mode === 'stateless') return ['runtime', 'dns'];
  return document.profile.automation?.regime === 'platform' ? PLATFORM_STAGES : STAGES;
}
const settingsPath = () => process.env.CNP_FAILOVER_SETTINGS || path.resolve(sourceRoot, '../phase1-deployment-20261029/portal-settings.json');
function settings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(value.app)) throw new Error('Nom de profil invalide.');
  return value;
}
function profileFor(app) {
  schema();
  const saved = db.prepare('SELECT document FROM failover_profiles WHERE app_name=?').get(app);
  if (saved) return JSON.parse(saved.document);
  const legacy = settings();
  return legacy?.app === app && legacy.exposeLegacyApplication !== false ? inputs(legacy) : null;
}
const enabled = dep => !!dep && dep.environment === 'prod'
  && dep.targetCluster !== 'azure' && !!profileFor(dep.appName);
function selectedApp(app) {
  const name = app || settings()?.app;
  if (!name || !profileFor(name)) throw new Error('Sélectionnez une application avec un profil failover configuré.');
  return name;
}
function profiles() {
  schema();
  const names = db.prepare('SELECT app_name FROM failover_profiles ORDER BY app_name').all().map(row => row.app_name);
  const legacy = settings();
  return [...new Set([...names, ...(legacy?.app && legacy.exposeLegacyApplication !== false ? [legacy.app] : [])])].sort();
}
function configure(app, document, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(app)) throw new Error('Nom d’application invalide.');
  if (!document || Object.keys(document).sort().join(',') !== 'credentials,observations,profile,secrets'
    || document.profile?.gcp?.app_name !== app || document.profile?.aws?.app_name !== app
    || document.secrets?.app !== app) throw new Error('Le profil et ses références doivent appartenir à cette application.');
  if (Object.keys(document.secrets).some(key => !['app', 'initialized', 'gcp_password_version', 'schema_version', 'created', 'unchanged', 'aws_secret_versions', 'kubernetes_secret', 'passwords_printed'].includes(key))) {
    throw new Error('Résultat d’initialisation expurgé requis ; aucune valeur secrète.');
  }
  const previous = profileFor(app);
  if (previous && (previous.profile.mode || 'postgres') !== (document.profile.mode || 'postgres') && rows(app).some(row => row.state === 'published')) {
    throw new Error('Un profil publié ne peut pas changer de mode de stockage sans procédure de migration.');
  }
  if (previous && rows(app).some(row => row.state === 'published')) {
    const immutable = profile => ({ mode: profile.mode || 'postgres',
      gcp: Object.fromEntries(['app_name', 'environment', 'database_name', 'credentials_secret_name', 'application_profile', 'sql_contract'].map(key => [key, profile.gcp[key]])),
      aws: Object.fromEntries(['app_name', 'environment', 'database_name', 'application_profile', 'sql_contract', 'runtime_user', 'database_security_group_id'].map(key => [key, profile.aws[key]])) });
    if (hash(immutable(previous.profile)) !== hash(immutable(document.profile))) {
      throw new Error('Les bases, secrets, contrats et identités d’un profil publié sont conservés. Une migration explicite est nécessaire.');
    }
  }
  for (const name of profiles().filter(name => name !== app)) {
    const other = profileFor(name).profile;
    if ((document.profile.gcp.credentials_secret_name && document.profile.gcp.credentials_secret_name === other.gcp.credentials_secret_name)
      || (document.profile.aws.listener_priority != null && document.profile.aws.listener_priority === other.aws.listener_priority)) {
      throw new Error('Le secret SQL et la priorité ALB doivent être dédiés à cette application.');
    }
  }
  // Validation réelle des contrats et références ; aucun appel cloud.
  render({ ...document, stage: 'validate' });
  schema();
  if (db.prepare("SELECT id FROM failover_candidates WHERE app_name=? AND state IN ('pending','approving')").get(app)) {
    throw new Error('Traitez la proposition en attente avant de modifier ce profil.');
  }
  db.prepare(`INSERT INTO failover_profiles(app_name,document,updated_by,updated_at) VALUES (?,?,?,?)
    ON CONFLICT(app_name) DO UPDATE SET document=excluded.document,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(app, JSON.stringify(document), user.id, new Date().toISOString());
  return { app, configured: true, activated: false };
}
function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS failover_candidates (
    id TEXT PRIMARY KEY, stage TEXT NOT NULL, base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL, pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL,
    files TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL,
    requested_by TEXT NOT NULL, reviewed_by TEXT, created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS failover_adoptions (
    deployment_id TEXT PRIMARY KEY, app_name TEXT NOT NULL, base_sha TEXT NOT NULL, reviewed_by TEXT NOT NULL, adopted_at TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS failover_profiles (
    app_name TEXT PRIMARY KEY, document TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  if (!db.pragma('table_info(failover_candidates)').some(column => column.name === 'image_record')) {
    db.exec('ALTER TABLE failover_candidates ADD COLUMN image_record TEXT');
  }
  if (!db.pragma('table_info(failover_candidates)').some(column => column.name === 'app_name')) {
    db.exec('ALTER TABLE failover_candidates ADD COLUMN app_name TEXT');
    // L'historique est rattaché aux chemins effectivement publiés, jamais au profil sélectionné.
    for (const row of db.prepare('SELECT id,files FROM failover_candidates').all()) {
      const apps = [...new Set(Object.keys(JSON.parse(row.files)).map(name => /^apps\/([^/]+)\/crossplane\/prod\//.exec(name)?.[1]).filter(Boolean))];
      if (apps.length === 1) db.prepare('UPDATE failover_candidates SET app_name=? WHERE id=?').run(apps[0], row.id);
    }
  }
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inputs(s) {
  const read = key => JSON.parse(fs.readFileSync(s[key], 'utf8'));
  return { profile: read('profile'), credentials: read('credentials'), secrets: read('secrets'),
    observations: s.observations && fs.existsSync(s.observations) ? read('observations') : {} };
}
// Paramètres propres à la plateforme, identiques pour toutes les applications : IP du LB GCP, identité et sous-réseau
// de Cloud Run, groupe de sécurité et CA de RDS, configuration de l'orchestration. Source : CNP_FAILOVER_PLATFORM,
// sinon data/failover-platform.json. Repli hérité, tant que ce fichier n'existe pas : le profil du pilote référencé par
// les paramètres partagés (ancien comportement de createProfile).
const platformPath = () => process.env.CNP_FAILOVER_PLATFORM || path.resolve(sourceRoot, 'data/failover-platform.json');
const AUTOMATION_REQUIRED = ['worker_image', 'ecs_cluster_arn', 'ecs_security_group_id', 'public_subnet_ids', 'subscription_ca_path_on_rds', 'kube_context'];
function validatePlatform(value) {
  const text = item => typeof item === 'string' && item.length > 0;
  const problems = [];
  if (!net.isIPv4(value?.gcp?.gcp_lb_ip)) problems.push('gcp.gcp_lb_ip');
  if (!text(value?.gcp?.gcp_runtime?.service_account)) problems.push('gcp.gcp_runtime.service_account');
  if (!text(value?.gcp?.gcp_runtime?.subnetwork)) problems.push('gcp.gcp_runtime.subnetwork');
  if (!/^sg-[a-z0-9]+$/.test(value?.aws?.database_security_group_id || '')) problems.push('aws.database_security_group_id');
  if (!text(value?.aws?.database_ca_pem) || !value.aws.database_ca_pem.includes('BEGIN CERTIFICATE')) problems.push('aws.database_ca_pem');
  const automation = value?.automation;
  if (!automation || typeof automation !== 'object' || Array.isArray(automation)) problems.push('automation');
  else for (const key of AUTOMATION_REQUIRED) if (!(key in automation)) problems.push(`automation.${key}`);
  if (problems.length) throw new Error(`Paramètres de plateforme invalides : ${problems.join(', ')}.`);
  return value;
}
function platform() {
  const file = platformPath();
  if (fs.existsSync(file)) return validatePlatform(JSON.parse(fs.readFileSync(file, 'utf8')));
  const legacy = settings();
  if (!legacy) throw new Error(`Paramètres de plateforme absents : créer ${file} ou définir CNP_FAILOVER_PLATFORM.`);
  const pilot = inputs(legacy).profile;
  return validatePlatform({
    gcp: { gcp_lb_ip: pilot.gcp?.gcp_lb_ip,
      gcp_runtime: { service_account: pilot.gcp?.gcp_runtime?.service_account, subnetwork: pilot.gcp?.gcp_runtime?.subnetwork } },
    aws: { database_security_group_id: pilot.aws?.database_security_group_id, database_ca_pem: pilot.aws?.database_ca_pem },
    automation: pilot.automation,
  });
}
function repository() {
  const name = config.github.configRepoName || 'Mooroon5-CNP/config-repo';
  if (name !== 'Mooroon5-CNP/config-repo') throw new Error('Dépôt phase 1 inattendu.');
  const [owner, repo] = name.split('/');
  return { owner, repo };
}
async function readFile(api, repo, file, ref) {
  const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...repo, path: file, ref });
  return Buffer.from(data.content, 'base64').toString();
}
async function baseline(api, repo, ref, app) {
  const dir = `apps/${app}/crossplane/prod`;
  let raw;
  try { raw = await readFile(api, repo, `${dir}/kustomization.yaml`, ref); }
  catch (err) { if (err.status !== 404) throw err; }
  const kustomization = raw ? yaml.load(raw) : { apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', resources: [] };
  const files = { [`${dir}/kustomization.yaml`]: JSON.stringify(kustomization) };
  for (const name of kustomization.resources) {
    if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(name)) throw new Error('Baseline non locale au dossier prod.');
    const text = await readFile(api, repo, `${dir}/${name}`, ref);
    const docs = yaml.loadAll(text);
    files[`${dir}/${name}`] = JSON.stringify(docs.length === 1 ? docs[0] : { apiVersion: 'v1', kind: 'List', items: docs });
  }
  const urlmap = yaml.load(await readFile(api, repo, 'platform/application-routing/urlmap.yaml', ref));
  return { files, kustomization, urlmap };
}
function render(request) {
  const python = process.env.CNP_FAILOVER_PYTHON || 'python3';
  try {
    return JSON.parse(execFileSync(python, [path.join(sourceRoot, 'scripts/failover/render.py')], {
      input: JSON.stringify(request), encoding: 'utf8', timeout: 30000,
      maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch (error) {
    // Seule la dernière ligne d'erreur du générateur, jamais la commande ni ses chemins.
    const reason = String(error.stderr || '').trim().split('\n').pop();
    throw new Error(reason || 'Rendu refusé.');
  }
}
// Révision applicative que servent les runtimes publiés (la dernière publication « runtime »), ou null.
function runtimeRevision(app) {
  schema();
  const row = db.prepare("SELECT image_record FROM failover_candidates WHERE app_name=? AND stage='runtime' AND state='published' ORDER BY created_at DESC LIMIT 1").get(app);
  return row?.image_record ? JSON.parse(row.image_record).revision : null;
}
function rows(app) {
  schema();
  return db.prepare(`SELECT id,app_name,stage,base_sha,head_sha,pr_number,pr_url,state,requested_by,reviewed_by,created_at FROM failover_candidates ${app ? 'WHERE app_name=?' : ''} ORDER BY created_at`).all(...(app ? [app] : []));
}
let busy = false;
// Verrou de publication : il se libère seul, l'appelant automatique réessaie au tour suivant au lieu de se bloquer.
const busyError = text => Object.assign(new Error(text), { retryable: true });
async function prepare(stage, user, requestedApp) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (!PLATFORM_STAGES.includes(stage) && stage !== 'protection') throw new Error('Étape phase 1 invalide.');
  if (busy) throw busyError('Préparation déjà en cours.');
  busy = true;
  try {
    schema();
    const app = selectedApp(requestedApp);
    const pending = db.prepare("SELECT id FROM failover_candidates WHERE app_name=? AND state IN ('pending','approving')").get(app);
    if (pending) throw new Error('Une proposition attend déjà sa validation.');
    const stages = stagesFor(profileFor(app));
    if (stage !== 'protection' && !stages.includes(stage)) throw new Error(stage === 'worker' ? 'Étape réservée au régime plateforme.' : 'Cette application ne nécessite pas de base SQL.');
    for (const previous of (stage === 'protection' ? [] : stages.slice(0, stages.indexOf(stage)))) {
      if (!db.prepare("SELECT id FROM failover_candidates WHERE app_name=? AND stage=? AND state='published'").get(app, previous)) {
        throw new Error(`Étape préalable non publiée : ${previous}.`);
      }
    }
    const input = profileFor(app);
    let imageRecord = null;
    if (stage === 'runtime') {
      const deployments = require('../models/deployment');
      const row = deployments.listForUser(null).find(row => row.app_name === app && row.deployment_environment === 'prod' && row.failover_requested);
      if (row) imageRecord = await require('./failover-ci-images').resolve(deployments.get(row.id));
    }
    const renderingInput = JSON.parse(JSON.stringify(input));
    if (imageRecord) {
      renderingInput.profile.gcp.gcp_runtime.image = imageRecord.gcp;
      renderingInput.profile.aws.image = imageRecord.aws;
    }
    const api = await github.getInstallationOctokit();
    const repo = repository();
    const { data: ref } = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...repo, ref: 'heads/main' });
    const base = ref.object.sha;
    const files = render({ ...renderingInput, stage, baseline: await baseline(api, repo, base, app) });
    for (const [name, content] of Object.entries(files)) {
      if ((!name.startsWith(`apps/${app}/crossplane/prod/`) && name !== 'platform/application-routing/urlmap.yaml') || typeof content !== 'string') {
        throw new Error('Fichier hors du périmètre de publication.');
      }
    }
    const id = randomUUID();
    const branch = `cnp-failover/${stage}/${id}`;
    await api.request('POST /repos/{owner}/{repo}/git/refs', { ...repo, ref: `refs/heads/${branch}`, sha: base });
    const service = require('./environment-deployment');
    const head = await service.commitFiles(api, repo, files, `feat(failover): ${stage} candidate`, branch);
    const { data: pr } = await api.request('POST /repos/{owner}/{repo}/pulls', { ...repo,
      title: `Failover ${app} — ${stage}`, head: branch, base: 'main',
      body: `Candidat généré par CNP Platform. Baseline ${base}. Validation manager obligatoire dans le portail.\n\nAucun retrait de ressource, bucket conservé. Aucun changement du tunnel.` });
    if (pr.user?.login !== 'cnp-platform-bot[bot]') throw new Error('Identité du bot de publication inattendue.');
    db.transaction(() => {
      db.prepare('INSERT INTO failover_candidates (id,stage,base_sha,head_sha,pr_number,pr_url,files,input_hash,state,requested_by,reviewed_by,created_at,app_name,image_record) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, stage, base, head, pr.number, pr.html_url, JSON.stringify(files), hash(input), 'pending', user.id, null,
        new Date().toISOString(), app, imageRecord ? JSON.stringify(imageRecord) : null);
    })();
    return { id, stage, prUrl: pr.html_url, head, files };
  } finally { busy = false; }
}
async function approve(id, expectedHead, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (busy) throw busyError('Publication déjà en cours.');
  busy = true;
  try {
    schema();
    const row = db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(id);
    if (!row || !['pending', 'approving'].includes(row.state) || row.head_sha !== expectedHead) throw new Error('Candidat absent, modifié ou déjà traité.');
    if (row.input_hash !== hash(profileFor(row.app_name))) throw new Error('Profil modifié depuis la préparation. Revue obsolète.');
    if (row.image_record) {
      const record = JSON.parse(row.image_record);
      const dep = require('../models/deployment').get(record.deploymentId);
      if (!dep || dep.appName !== row.app_name || dep.environment !== 'prod') throw new Error('Déploiement CI modifié.');
      const actual = await require('./failover-ci-images').resolve(dep, record.revision);
      if (hash(actual) !== hash(record)) throw new Error('Les images CI ont changé depuis la préparation.');
    }
    const api = await github.getInstallationOctokit();
    const repo = repository();
    const { data: pr } = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...repo, pull_number: row.pr_number });
    // Un timeout peut survenir après le merge GitHub : reprendre seulement une
    // approbation déjà tracée, sur le même SHA, effectuée par le bot prévu.
    if (row.state === 'approving' && row.reviewed_by && pr.merged && pr.head.sha === row.head_sha
      && pr.base.ref === 'main' && pr.merged_by?.login === 'cnp-platform-bot[bot]') {
      db.prepare("UPDATE failover_candidates SET state='published' WHERE id=?").run(id);
      return { id, published: true, sha: pr.merge_commit_sha, prUrl: row.pr_url };
    }
    const { data: main } = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...repo, ref: 'heads/main' });
    if (pr.state !== 'open' || pr.base.ref !== 'main' || pr.head.sha !== row.head_sha || main.object.sha !== row.base_sha) {
      throw new Error('PR ou baseline modifiée : préparer un nouveau candidat.');
    }
    db.prepare("UPDATE failover_candidates SET state='approving',reviewed_by=? WHERE id=?").run(user.id, id);
    const { data: result } = await api.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', {
      ...repo, pull_number: row.pr_number, sha: row.head_sha, merge_method: 'squash',
    });
    if (!result.merged) {
      db.prepare("UPDATE failover_candidates SET state='pending' WHERE id=?").run(id);
      throw new Error('GitHub refuse le merge.');
    }
    db.prepare("UPDATE failover_candidates SET state='published',reviewed_by=? WHERE id=?").run(user.id, id);
    return { id, published: true, sha: result.sha, prUrl: row.pr_url };
  } finally { busy = false; }
}
// Ressources qui suivent la vie de l'application (render.py) : toutes les autres doivent survivre au retrait d'un manifest.
const WORKER_KINDS = new Set(['MetricAlarm', 'TableItem']);
const ROUTING = 'platform/application-routing/urlmap.yaml';
// Contrôles du contenu d'une publication avant son approbation automatique. Le contenu est celui enregistré à la préparation,
// identique à la PR (approve vérifie que la PR pointe toujours sur ce commit).
function contentProblems(row) {
  const files = JSON.parse(row.files);
  const prefix = `apps/${row.app_name}/crossplane/prod/`;
  const problems = [];
  const parsed = {};
  for (const [name, text] of Object.entries(files)) {
    if (name === ROUTING) {
      if (row.stage !== 'runtime') problems.push(`${name} : routage modifié hors de l'étape runtime`);
      continue;
    }
    if (!name.startsWith(prefix) || name.slice(prefix.length).includes('/')) { problems.push(`${name} : hors du dossier de l'application`); continue; }
    try { parsed[name.slice(prefix.length)] = JSON.parse(text); } catch (_) { problems.push(`${name} : contenu illisible`); }
  }
  const kustomization = parsed['kustomization.yaml'];
  if (kustomization?.kind !== 'Kustomization' || !Array.isArray(kustomization.resources)) problems.push('kustomization.yaml absent ou invalide');
  else for (const name of kustomization.resources) if (!(name in parsed)) problems.push(`${name} : référencé mais absent`);
  for (const [name, value] of Object.entries(parsed)) {
    for (const item of value.kind === 'List' ? value.items || [] : [value]) {
      if (item?.spec?.forProvider === undefined || WORKER_KINDS.has(item.kind)) continue;
      if (item.spec.deletionPolicy !== 'Orphan') problems.push(`${name} : ${item.kind} ${item.metadata?.name} sans deletionPolicy Orphan`);
    }
  }
  return problems;
}
// Approbation automatique (mode par défaut) : mêmes vérifications qu'une approbation manuelle, plus les contrôles de contenu.
// Un contrôle en échec refuse : rien n'est publié, la proposition reste en attente pour que le manager la rejette.
async function autoApprove(id, user) {
  schema();
  const row = db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(id);
  if (!row) throw new Error('Candidat absent.');
  const problems = contentProblems(row);
  if (problems.length) {
    throw new Error(`Publication ${row.stage} refusée par les contrôles automatiques : ${problems.slice(0, 5).join(' ; ')}. Rejeter la proposition puis reprendre.`);
  }
  return approve(id, row.head_sha, user);
}
async function reject(id, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (busy) throw busyError('Publication déjà en cours.');
  busy = true;
  try {
    schema();
    const row = db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(id);
    if (!row || row.state !== 'pending') throw new Error('Proposition non disponible pour rejet.');
    const api = await github.getInstallationOctokit();
    const repo = repository();
    const { data: pr } = await api.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...repo, pull_number: row.pr_number });
    if (pr.merged) throw new Error('Une proposition déjà fusionnée ne peut pas être rejetée.');
    if (pr.state === 'open') await api.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...repo, pull_number: row.pr_number, state: 'closed' });
    db.prepare("UPDATE failover_candidates SET state='rejected',reviewed_by=? WHERE id=?").run(user.id, id);
    return { id, rejected: true };
  } finally { busy = false; }
}
function manifests(dep) {
  if (!enabled(dep)) return null;
  schema();
  const row = db.prepare("SELECT files FROM failover_candidates WHERE app_name=? AND state='published' ORDER BY created_at DESC LIMIT 1").get(dep.appName);
  if (!row) throw new Error('Profil phase 1 : préparer et approuver le premier lot dans /failover.');
  // Un déploiement CI ordinaire conserve le profil effectivement approuvé.
  // Changer une image ou un endpoint exige une nouvelle proposition runtime.
  return Object.fromEntries(Object.entries(JSON.parse(row.files)).filter(([name]) => name.startsWith('apps/')));
}
function operationalPackage(app, stage, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  selectedApp(app);
  if (!['bootstrap', 'automation', 'secrets'].includes(stage)) throw new Error('Paquet inconnu.');
  const input = profileFor(app);
  if (stage !== 'automation') return render({ ...input, stage });
  // Régime plateforme : chaque app a son enregistrement, aucun varfile partagé à reconstituer.
  if (input.profile.automation?.regime === 'platform') return render({ ...input, stage });
  // Le worker est partagé : ne jamais produire un varfile qui ferait disparaître
  // les applications déjà configurées du plan Terraform suivant.
  const applications = [];
  let combined, selected;
  for (const name of profiles()) {
    const document = profileFor(name);
    if (document.profile.mode === 'stateless') continue;
    if (name !== app && !rows(name).some(row => row.stage === 'dns' && row.state === 'published')) continue;
    const result = render({ ...document, stage: 'automation' });
    const vars = result['automation.tfvars.json'];
    const shared = Object.fromEntries(Object.entries(vars).filter(([key]) => key !== 'applications'));
    if (combined && hash(combined) !== hash(shared)) throw new Error('Les applications doivent partager le même worker et réseau ECS.');
    combined = shared;
    applications.push(...vars.applications);
    if (name === app) selected = result;
  }
  if (!selected || applications.length > 10) throw new Error('Configuration du worker absente ou capacité dépassée.');
  return { ...selected, 'worker-config.json': { applications },
    'automation.tfvars.json': { ...combined, applications },
    'review.json': { applications: applications.map(value => value.app), enable_triggers: false,
      applied: false, note: 'Conserver les varfiles bootstrap et activation existants ; plan sans suppression ni remplacement obligatoire.' } };
}
async function adoptionPreview(app, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  selectedApp(app);
  const api = await github.getInstallationOctokit();
  const repo = repository();
  const { data: ref } = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...repo, ref: 'heads/main' });
  const registry = yaml.load(await readFile(api, repo, 'apps/registry.yaml', ref.object.sha));
  const registered = registry.apps?.find(item => item.app_name === app);
  if (!registered || !registered.environments?.includes('prod')) throw new Error('Application de production absente du registre.');
  const remote = await baseline(api, repo, ref.object.sha, app);
  if (!remote.kustomization.resources.length) throw new Error('Aucune ressource de production à rattacher.');
  const application = await require('../clients/argocd').getApplicationDetails(`${app}-prod`);
  const spec = application.spec;
  if (application.metadata?.deletionTimestamp || spec?.source?.repoURL !== `https://github.com/${repo.owner}/${repo.repo}.git`
    || spec.source.path !== `apps/${app}/crossplane/prod` || spec.source.targetRevision !== 'main'
    || spec.destination?.server !== 'https://kubernetes.default.svc') throw new Error('Propriétaire GitOps absent, en suppression ou incompatible.');
  return { app, githubRepoUrl: registered.repo_url, head: ref.object.sha, resources: remote.kustomization.resources, cloudChanges: false };
}
async function adopt(app, expectedHead, user) {
  const preview = await adoptionPreview(app, user);
  if (preview.head !== expectedHead) throw new Error('La baseline a changé : examinez de nouveau le rattachement.');
  const deployments = require('../models/deployment');
  const registered = deployments.listForUser(null).find(row => row.app_name === app && row.deployment_environment === 'prod');
  if (registered && registered.github_repo_url !== preview.githubRepoUrl) throw new Error('Ce déploiement local appartient à un autre dépôt.');
  const port = profileFor(app).profile.gcp.container_port || 8080;
  return db.transaction(() => {
    const dep = registered ? deployments.get(registered.id) : deployments.create({ appName: app,
      githubRepoUrl: preview.githubRepoUrl, appPort: port, ownerUserId: user.id, environment: 'prod', targetCluster: 'gcp', failoverRequested: true });
    db.prepare(`INSERT INTO failover_adoptions VALUES (?,?,?,?,?) ON CONFLICT(deployment_id) DO UPDATE SET
      base_sha=excluded.base_sha,reviewed_by=excluded.reviewed_by,adopted_at=excluded.adopted_at`)
      .run(dep.id, app, preview.head, user.id, new Date().toISOString());
    db.prepare('UPDATE deployments SET failover_requested=1 WHERE id=?').run(dep.id);
    deployments.updateOnboardingStatus(dep.id, 'ready');
    return { app, deploymentId: dep.id, adopted: true, cloudChanges: false };
  })();
}
function adopted(dep) {
  schema();
  return !!db.prepare('SELECT deployment_id FROM failover_adoptions WHERE deployment_id=? AND app_name=?').get(dep.id, dep.appName);
}
async function deploymentStatus(dep) {
  if (!dep.failoverRequested) return readiness(dep);
  try {
    const { run } = await require('./failover-ci-images').latest(dep);
    if (run.status !== 'completed') return { phase: 'running', message: 'Construction et vérification des images GCP et AWS en cours.', runUrl: run.html_url };
    if (run.conclusion !== 'success') return { phase: 'failed', message: 'Le pipeline a échoué ; la version publiée est conservée.', runUrl: run.html_url };
    // La mise en service s'enchaîne seule (publications contrôlées puis approuvées automatiquement) : on montre où elle en est,
    // sans proposer d'action. Seul un blocage demande l'intervention d'un manager.
    const progress = require('./failover-provisioning').progress(dep.appName);
    if (!progress) return { phase: 'deploying', message: 'Images prêtes sur GCP et AWS ; mise en service du secours pas encore lancée.', runUrl: run.html_url };
    if (progress.state === 'blocked') return { phase: 'failed', message: `Mise en service du secours bloquée : ${progress.message}`, runUrl: run.html_url };
    if (progress.state !== 'completed') {
      const step = progress.total ? ` (étape ${Math.min(progress.step + 1, progress.total)}/${progress.total})` : '';
      const label = { update: 'Mise à jour sur GCP et AWS', failback: 'Retour vers GCP' }[progress.phase] || 'Mise en service du secours';
      return { phase: 'deploying', message: `${label}${step} : ${progress.message || 'en cours.'}`, runUrl: run.html_url };
    }
    return readiness(dep);
  } catch (error) {
    return { phase: 'waiting', message: 'En attente de la première exécution réussie du pipeline (images GCP et AWS).' };
  }
}
function readiness(dep) {
  if (!enabled(dep)) return null;
  const stages = new Set(rows(dep.appName).filter(row => row.state === 'published').map(row => row.stage));
  const required = stagesFor(profileFor(dep.appName));
  const next = required.find(stage => !stages.has(stage));
  const operations = require('./failover-operations');
  const health = operations.list(dep.appName).find(row => row.action === 'health' && row.state === 'completed');
  const age = health ? Date.now() / 1000 - health.result?.observed_at : Infinity;
  if (!next && health?.result?.verified && health.input_hash === hash(profileFor(dep.appName)) && age >= 0 && age < 120) {
    // Servie par AWS : le voyant dit si GCP est revenu, et donc si le retour manuel peut être lancé.
    const gcp = health.result.state === 'AWS_ACTIVE' ? require('./failover-provisioning').gcpStatus(dep.appName) : null;
    return { phase: 'success', message: health.result.state === 'AWS_ACTIVE' ? 'Secours AWS actif : l’application est servie par AWS.' : 'Application déployée ; secours vérifié et disponible.',
      applicationUrl: `https://${dep.appName}.apps.mooroon5.fr`, failoverState: health.result.state,
      ...(gcp ? { gcpAvailable: gcp.available && gcp.fresh, gcpMessage: gcp.message } : {}) };
  }
  return { phase: 'deploying', message: next ? `Mise en service du secours en cours (${next} à publier).`
    : 'Runtimes et DNS publiés ; vérification de la réplication et du worker en cours.', cloudRunUrl: null };
}
module.exports = { profiles, configure, profileFor, enabled, settings, inputs, platform, render, rows, runtimeRevision, prepare, approve, autoApprove, contentProblems, reject, manifests, readiness,
  adoptionPreview, adopt, adopted, operationalPackage, deploymentStatus, stagesFor };
