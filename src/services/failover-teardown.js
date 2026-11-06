'use strict';

// Suppression complète d'une application failover, lancée par le bouton « Supprimer » : tout ce que la mise en service a créé
// disparaît (bases sans snapshot final, runtimes, DNS, sondes, alarme, configuration du worker, secrets, état du worker).
// La protection reste pour le reste : une ressource retirée de Git par erreur garde deletionPolicy Orphan ; seule cette
// suppression explicite la passe en Delete, avant de la retirer.
// Tâche durable (les bases mettent plusieurs minutes à disparaître), reprise par le réconciliateur après un redémarrage.
const { randomUUID } = require('crypto');
const yaml = require('js-yaml');
const db = require('../models/db');
const profiles = require('./environment-failover');
const operations = require('./failover-operations');
const routing = require('./application-routing');
const github = require('../clients/github');

const STEPS = [
  ['commit', 'release'], ['operation', 'teardown-released'],
  ['commit', 'remove'], ['operation', 'teardown-gone'],
  ['operation', 'teardown-cleanup'], ['local', 'forget'],
];
// Délai d'attente maximal d'une étape qui attend le fournisseur (libération : mises à jour Crossplane ; disparition : bases).
const PATIENCE = { 'teardown-released': 1800000, 'teardown-gone': 3600000 };

function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS failover_teardown (
    app TEXT PRIMARY KEY, deployment_id TEXT NOT NULL, requested_by TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, reference TEXT, message TEXT, started_at TEXT NOT NULL, step_started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)`);
}
function get(app) {
  schema();
  return db.prepare('SELECT * FROM failover_teardown WHERE app=?').get(app) || null;
}
function start(dep, user) {
  if (!user?.id) throw new Error('Utilisateur requis.');
  if (!profiles.enabled(dep)) throw new Error('Aucun failover à supprimer pour ce déploiement.');
  schema();
  if (get(dep.appName)) return get(dep.appName);
  const now = new Date().toISOString();
  db.transaction(() => {
    // La surveillance de santé de la mise en service s'arrête : l'application va disparaître.
    try { db.prepare('DELETE FROM failover_provisioning WHERE app=?').run(dep.appName); } catch (_) { /* table absente */ }
    db.prepare(`INSERT INTO failover_teardown (app,deployment_id,requested_by,state,started_at,step_started_at,updated_at)
      VALUES (?,?,?,'running',?,?,?)`).run(dep.appName, dep.id, user.id, now, now, now);
  })();
  return get(dep.appName);
}

// Les manifests de l'application tels qu'ils sont publiés, puis leur version « libérée » : Delete partout, protection des
// bases levée, aucun snapshot final. Les ressources en observation seule (bucket historique) ne sont jamais détruites.
function release(document) {
  const value = JSON.parse(JSON.stringify(document));
  for (const item of value.kind === 'List' ? value.items || [] : [value]) {
    const spec = item?.spec;
    const policies = spec?.managementPolicies;
    // Observation seule (ressource que Crossplane n'a pas créée, comme le bucket historique) : jamais détruite.
    if (!spec?.forProvider || (policies && !policies.includes('*') && !policies.includes('Delete') && !policies.includes('Create'))) continue;
    // Créée par Crossplane sans droit de suppression (verrou DNS) : la suppression de l'app la lui rend.
    if (policies && !policies.includes('*') && !policies.includes('Delete')) spec.managementPolicies = [...policies, 'Delete'];
    spec.deletionPolicy = 'Delete';
    if (item.kind === 'DatabaseInstance') {
      spec.forProvider.deletionProtection = false;
      spec.forProvider.settings = { ...(spec.forProvider.settings || {}), deletionProtectionEnabled: false };
    }
    if (item.kind === 'Instance' && String(item.apiVersion).startsWith('rds.')) {
      Object.assign(spec.forProvider, { deletionProtection: false, skipFinalSnapshot: true, deleteAutomatedBackups: true });
    }
  }
  return value;
}
async function published(api, repo, app, ref) {
  const dir = `apps/${app}/crossplane/prod`;
  const read = async file => {
    try {
      const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...repo, path: file, ref });
      return Buffer.from(data.content, 'base64').toString();
    } catch (err) { if (err.status === 404) return null; throw err; }
  };
  const raw = await read(`${dir}/kustomization.yaml`);
  if (!raw) return { dir, kustomization: null, files: {} };
  const kustomization = yaml.load(raw);
  const files = {};
  for (const name of kustomization.resources || []) {
    if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(name)) throw new Error('Manifest hors du dossier de l’application.');
    const text = await read(`${dir}/${name}`);
    if (text !== null) {
      const docs = yaml.loadAll(text);
      files[name] = docs.length === 1 ? docs[0] : { apiVersion: 'v1', kind: 'List', items: docs };
    }
  }
  return { dir, kustomization, files };
}
async function commit(action, row) {
  const api = await github.getInstallationOctokit();
  const repo = repositoryOf();
  const deployment = require('./environment-deployment');
  const dep = { appName: row.app, environment: 'prod' };
  await deployment.commitFiles(api, repo, async head => {
    const { dir, kustomization, files } = await published(api, repo, row.app, head);
    const result = {};
    if (action === 'release') {
      for (const [name, value] of Object.entries(files)) result[`${dir}/${name}`] = JSON.stringify(release(value), null, 2) + '\n';
      return result;
    }
    // Retrait : la liste des ressources se vide (Argo CD les élague, Crossplane détruit chez le fournisseur), la route partagée
    // de l'application part dans le même commit pour libérer son service GCP.
    for (const name of Object.keys(files)) result[`${dir}/${name}`] = null;
    if (kustomization) result[`${dir}/kustomization.yaml`] = yaml.dump({ ...kustomization, resources: [] });
    const map = await (async () => {
      try {
        const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...repo, path: routing.ROUTING_PATH, ref: head });
        return yaml.load(Buffer.from(data.content, 'base64').toString());
      } catch (err) { if (err.status === 404) return null; throw err; }
    })();
    if (map) result[routing.ROUTING_PATH] = yaml.dump(routing.updateMap(map, dep, true));
    return result;
  }, `chore(${row.app}): ${action === 'release' ? 'release failover resources for deletion' : 'remove failover resources'}`);
}
function repositoryOf() {
  const { config } = require('../config/env');
  const [owner, repo] = (config.github.configRepoName || 'Mooroon5-CNP/config-repo').split('/');
  return { owner, repo };
}
// Dernière étape : la désinscription habituelle (registre, dossier), puis l'oubli de l'application dans le portail.
async function forget(row) {
  const deployments = require('../models/deployment');
  const dep = deployments.get(row.deployment_id);
  if (dep) await require('./environment-deployment').remove(dep, { afterFailoverTeardown: true });
  db.transaction(() => {
    for (const [table, column] of [['failover_candidates', 'app_name'], ['failover_operations', 'app'], ['failover_profiles', 'app_name'],
      ['failover_provisioning', 'app'], ['failover_adoptions', 'app_name']]) {
      try { db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(row.app); } catch (_) { /* table absente */ }
    }
    if (dep) {
      require('../models/deletion_request').deleteByDeployment(dep.id);
      deployments.delete(dep.id);
    }
  })();
}

async function advance(app) {
  schema();
  const owner = randomUUID();
  if (!db.prepare(`UPDATE failover_teardown SET lease_owner=?,lease_until=? WHERE app=? AND state IN ('running','waiting') AND lease_until < ?`)
    .run(owner, Date.now() + 900000, app, Date.now()).changes) return;
  const save = (state, message, reference, next = false) => {
    const now = new Date().toISOString();
    db.prepare(`UPDATE failover_teardown SET state=?,message=?,reference=?,updated_at=?,step=step+?,
      step_started_at=CASE WHEN ? THEN ? ELSE step_started_at END WHERE app=? AND lease_owner=?`)
      .run(state, message, reference || null, now, next ? 1 : 0, next ? 1 : 0, now, app, owner);
  };
  try {
    const row = get(app);
    const [kind, action] = STEPS[row.step] || [];
    if (!kind) { save('completed', 'Application et secours supprimés.'); return; }
    if (kind === 'commit') { await commit(action, row); save('running', `${action} publié.`, null, true); return; }
    if (kind === 'local') { await forget(row); save('completed', 'Application et secours supprimés.', null, true); return; }
    const actor = { id: row.requested_by, role: 'manager' };
    let operation = row.reference ? operations.list(app).find(value => value.id === row.reference.slice(10)) : null;
    if (!operation) {
      operation = operations.start(app, action, actor);
      save('running', `En cours : ${action}.`, `operation:${operation.id}`); return;
    }
    if (operation.state === 'running') return;
    if (operation.state === 'completed' && operation.result?.verified === true) { save('running', `${action} vérifié.`, null, true); return; }
    if (PATIENCE[action] && Date.now() - Date.parse(row.step_started_at) < PATIENCE[action]) {
      // Le fournisseur converge : nouvelle lecture (sans effet), en disant ce qui reste.
      const hint = operation.result?.message || operation.result?.error;
      const next = operations.start(app, action, actor);
      save('waiting', hint || `Attente : ${action}.`, `operation:${next.id}`); return;
    }
    throw new Error(operation.result?.error || operation.result?.message || `Étape ${action} non validée.`);
  } catch (error) {
    save('blocked', error.message, get(app)?.reference);
  } finally {
    db.prepare('UPDATE failover_teardown SET lease_owner=NULL,lease_until=0 WHERE app=? AND lease_owner=?').run(app, owner);
  }
}
function resume(app) {
  const row = get(app);
  if (!row || row.state !== 'blocked') throw new Error('Aucune suppression bloquée à reprendre.');
  db.prepare("UPDATE failover_teardown SET state='running',reference=NULL,message=NULL,step_started_at=? WHERE app=?").run(new Date().toISOString(), app);
  return get(app);
}
async function tick() {
  schema();
  for (const row of db.prepare("SELECT app FROM failover_teardown WHERE state IN ('running','waiting')").all()) await advance(row.app);
}
module.exports = { STEPS, get, start, release, advance, resume, tick };
