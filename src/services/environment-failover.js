'use strict';

// Profil opt-in de phase 1, séparé du parcours Azure de Maia. Les fichiers sont
// générés depuis la baseline Git distante et publiés uniquement par la GitHub
// App, après revue manager du contenu exact. Aucun apply cloud dans ce module.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash, randomUUID } = require('crypto');
const yaml = require('js-yaml');
const db = require('../models/db');
const { config } = require('../config/env');
const github = require('../clients/github');
const sourceRoot = path.resolve(path.dirname(fs.realpathSync(__filename)), '../..');

const STAGES = ['databases', 'runtime', 'dns'];
const settingsPath = () => process.env.CNP_FAILOVER_SETTINGS || path.resolve(sourceRoot, '../phase1-deployment-20261029/portal-settings.json');
function settings() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.app !== 'app4-pixelcam') throw new Error('Profil phase 1 non autorisé.');
  return value;
}
const enabled = dep => !!dep && dep.appName === 'app4-pixelcam' && dep.environment === 'prod'
  && dep.targetCluster !== 'azure' && !!settings();
function schema() {
  db.exec(`CREATE TABLE IF NOT EXISTS failover_candidates (
    id TEXT PRIMARY KEY, stage TEXT NOT NULL, base_sha TEXT NOT NULL,
    head_sha TEXT NOT NULL, pr_number INTEGER NOT NULL, pr_url TEXT NOT NULL,
    files TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL,
    requested_by TEXT NOT NULL, reviewed_by TEXT, created_at TEXT NOT NULL
  )`);
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inputs(s) {
  const read = key => JSON.parse(fs.readFileSync(s[key], 'utf8'));
  return { profile: read('profile'), credentials: read('credentials'), secrets: read('secrets'),
    observations: s.observations && fs.existsSync(s.observations) ? read('observations') : {} };
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
async function baseline(api, repo, ref) {
  const dir = 'apps/app4-pixelcam/crossplane/prod';
  const raw = await readFile(api, repo, `${dir}/kustomization.yaml`, ref);
  const kustomization = yaml.load(raw);
  const files = { [`${dir}/kustomization.yaml`]: JSON.stringify(kustomization) };
  for (const name of kustomization.resources) {
    if (!/^[a-zA-Z0-9_.-]+\.ya?ml$/.test(name)) throw new Error('Baseline non locale au dossier prod.');
    const text = await readFile(api, repo, `${dir}/${name}`, ref);
    const docs = yaml.loadAll(text);
    files[`${dir}/${name}`] = docs.length === 1 ? JSON.stringify(docs[0]) : text;
  }
  const urlmap = yaml.load(await readFile(api, repo, 'platform/application-routing/urlmap.yaml', ref));
  return { files, kustomization, urlmap };
}
function render(request) {
  const python = process.env.CNP_FAILOVER_PYTHON || 'python3';
  return JSON.parse(execFileSync(python, [path.join(sourceRoot, 'scripts/failover/render.py')], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 30000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}
function rows() {
  schema();
  return db.prepare('SELECT id,stage,base_sha,head_sha,pr_number,pr_url,state,requested_by,reviewed_by,created_at FROM failover_candidates ORDER BY created_at').all();
}
let busy = false;
async function prepare(stage, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (!STAGES.includes(stage)) throw new Error('Étape phase 1 invalide.');
  if (busy) throw new Error('Préparation déjà en cours.');
  busy = true;
  try {
    schema();
    const s = settings();
    if (!s) throw new Error('Profil phase 1 absent.');
    const pending = db.prepare("SELECT id FROM failover_candidates WHERE state IN ('pending','approving')").get();
    if (pending) throw new Error('Une proposition attend déjà sa validation.');
    for (const previous of STAGES.slice(0, STAGES.indexOf(stage))) {
      if (!db.prepare("SELECT id FROM failover_candidates WHERE stage=? AND state='published'").get(previous)) {
        throw new Error(`Étape préalable non publiée : ${previous}.`);
      }
    }
    const input = inputs(s);
    const api = await github.getInstallationOctokit();
    const repo = repository();
    const { data: ref } = await api.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...repo, ref: 'heads/main' });
    const base = ref.object.sha;
    const files = render({ ...input, stage, baseline: await baseline(api, repo, base) });
    for (const [name, content] of Object.entries(files)) {
      if ((!name.startsWith('apps/app4-pixelcam/crossplane/prod/') && name !== 'platform/application-routing/urlmap.yaml') || typeof content !== 'string') {
        throw new Error('Fichier hors du périmètre de publication.');
      }
    }
    const id = randomUUID();
    const branch = `cnp-failover/${stage}/${id}`;
    await api.request('POST /repos/{owner}/{repo}/git/refs', { ...repo, ref: `refs/heads/${branch}`, sha: base });
    const service = require('./environment-deployment');
    const head = await service.commitFiles(api, repo, files, `feat(failover): ${stage} candidate`, branch);
    const { data: pr } = await api.request('POST /repos/{owner}/{repo}/pulls', { ...repo,
      title: `Phase 1 Pixelcalm — ${stage}`, head: branch, base: 'main',
      body: `Candidat généré par CNP Platform. Baseline ${base}. Validation manager obligatoire dans le portail.\n\nAucun retrait de ressource, bucket conservé. Aucun changement du tunnel.` });
    if (pr.user?.login !== 'cnp-platform-bot[bot]') throw new Error('Identité du bot de publication inattendue.');
    db.prepare('INSERT INTO failover_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, stage, base, head, pr.number, pr.html_url, JSON.stringify(files), hash(input), 'pending', user.id, null, new Date().toISOString());
    return { id, stage, prUrl: pr.html_url, head, files };
  } finally { busy = false; }
}
async function approve(id, expectedHead, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (busy) throw new Error('Publication déjà en cours.');
  busy = true;
  try {
    schema();
    const row = db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(id);
    if (!row || !['pending', 'approving'].includes(row.state) || row.head_sha !== expectedHead) throw new Error('Candidat absent, modifié ou déjà traité.');
    if (row.input_hash !== hash(inputs(settings()))) throw new Error('Profil modifié depuis la préparation. Revue obsolète.');
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
async function reject(id, user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  if (busy) throw new Error('Publication déjà en cours.');
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
  const row = db.prepare("SELECT files FROM failover_candidates WHERE state='published' ORDER BY created_at DESC LIMIT 1").get();
  if (!row) throw new Error('Profil phase 1 : préparer et approuver le premier lot dans /failover.');
  // Un déploiement CI ordinaire conserve le profil effectivement approuvé.
  // Changer une image ou un endpoint exige une nouvelle proposition runtime.
  return Object.fromEntries(Object.entries(JSON.parse(row.files)).filter(([name]) => name.startsWith('apps/')));
}
function readiness(dep) {
  if (!enabled(dep)) return null;
  return { phase: 'deploying', message: 'Profil phase 1 : validation des bases, réplication et worker requise ; consulter /failover.', cloudRunUrl: null };
}
module.exports = { enabled, settings, inputs, render, rows, prepare, approve, reject, manifests, readiness };
