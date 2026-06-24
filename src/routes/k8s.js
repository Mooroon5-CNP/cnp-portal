'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireRole, can } = require('../middleware/rbac');
const k8sService = require('../services/k8s');
const deploymentModel = require('../models/deployment');
const teamService = require('../services/teams');
const githubService = require('../services/github');
const { config } = require('../config/env');

// Resolve config-repo owner/repo from "owner/repo" env var.
function configRepo() {
  const parts = (config.github.configRepoName || '').split('/');
  return { owner: parts[0] || '', repo: parts[1] || '', token: config.github.configRepoToken };
}

// Returns the Set of app names that belong to the current user's teams.
function getUserAppNames(user) {
  const teams = teamService.getTeamsForUser(user.id);
  const teamIds = new Set(teams.map(t => t.id));
  const rows = deploymentModel.listForUser(user);
  const isManager = user.role === 'manager';
  const mine = isManager
    ? rows
    : rows.filter(d =>
        d.owner_user_id === user.id ||
        (d.owner_team_id && teamIds.has(d.owner_team_id))
      );
  return new Set(mine.map(d => d.app_name));
}

// ── Pods / quotas / events ────────────────────────────────────────────────────

router.get('/pods', requireAuth, requirePermission('k8s:pods:view-own'), async (req, res) => {
  const isManager = req.user.role === 'manager';
  const userAppNames = getUserAppNames(req.user);

  function podInScope(pod) {
    if (isManager) return true;
    return userAppNames.has(pod.app) ||
           userAppNames.has((pod.namespace || '').replace(/-dev$|-prod$/, ''));
  }
  function quotaInScope(q) {
    if (isManager) return true;
    return [...userAppNames].some(n => (q.namespace || '').startsWith(n));
  }

  const [allPods, allQuotas, events] = await Promise.all([
    k8sService.listPods(),
    k8sService.listQuotas(),
    can(req.user, 'k8s:events:view') ? k8sService.listEvents() : [],
  ]);

  const pods   = allPods.filter(podInScope);
  const quotas = allQuotas.filter(quotaInScope);

  res.render('k8s/pods', {
    title: 'Ressources K8s — CNP Portal',
    currentPage: 'k8s',
    pods,
    quotas,
    events,
    user: req.user,
    userAppNames: [...userAppNames],
    can: (p) => can(req.user, p),
  });
});

router.post('/pods/:name/delete', requireAuth, requirePermission('k8s:pods:delete'), async (req, res) => {
  const namespace = req.body.namespace;
  if (!namespace) {
    req.flash('error', 'Namespace manquant.');
    return res.redirect('/k8s/pods');
  }
  try {
    await k8sService.deletePod(req.params.name, namespace);
    req.flash('success', `Pod ${req.params.name} supprimé.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/k8s/pods');
});

router.post('/deployments/:name/scale', requireAuth, requirePermission('k8s:pods:scale'), async (req, res) => {
  const replicas = parseInt(req.body.replicas);
  const namespace = req.body.namespace;
  if (!namespace) {
    req.flash('error', 'Namespace manquant.');
    return res.redirect('/k8s/pods');
  }
  try {
    await k8sService.scaleDeployment(req.params.name, replicas, namespace);
    req.flash('success', `Déploiement ${req.params.name} mis à l'échelle: ${replicas} réplica(s).`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/k8s/pods');
});

// ── YAML editor (DevOps only) ─────────────────────────────────────────────────

// GET /k8s/apps/:appName/edit — show file tree + editor
router.get('/apps/:appName/edit', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const { appName } = req.params;
  const userAppNames = getUserAppNames(req.user);
  if (!userAppNames.has(appName)) {
    req.flash('error', 'Accès refusé à cette application.');
    return res.redirect('/k8s/pods');
  }

  const { owner, repo, token } = configRepo();
  const base    = `apps/${appName}/base`;
  const devDir  = `apps/${appName}/overlays/dev`;
  const prodDir = `apps/${appName}/overlays/prod`;

  const [baseFiles, devFiles, prodFiles] = await Promise.all([
    githubService.listDirectory(owner, repo, base,    token),
    githubService.listDirectory(owner, repo, devDir,  token),
    githubService.listDirectory(owner, repo, prodDir, token),
  ]);

  const yamlOnly = f => f.type === 'file' && /\.ya?ml$/.test(f.name);
  const fileTree = [
    { label: 'base/',          files: baseFiles.filter(yamlOnly) },
    { label: 'overlays/dev/',  files: devFiles.filter(yamlOnly) },
    { label: 'overlays/prod/', files: prodFiles.filter(yamlOnly) },
  ];

  res.render('k8s/editor', {
    title: `Éditeur YAML — ${appName}`,
    currentPage: 'k8s',
    appName,
    fileTree,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

// GET /k8s/apps/:appName/file?path=... — return file content + sha as JSON
router.get('/apps/:appName/file', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const { appName } = req.params;
  const filePath    = req.query.path;

  if (!filePath || !filePath.startsWith(`apps/${appName}/`)) {
    return res.status(400).json({ error: 'Chemin invalide.' });
  }
  const userAppNames = getUserAppNames(req.user);
  if (!userAppNames.has(appName)) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }

  const { owner, repo, token } = configRepo();
  try {
    const { content, sha } = await githubService.getFileWithSha(owner, repo, filePath, token);
    res.json({ content, sha });
  } catch (_) {
    res.status(404).json({ error: 'Fichier introuvable.' });
  }
});

// POST /k8s/apps/:appName/file — commit updated file to config-repo
router.post('/apps/:appName/file', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const { appName }               = req.params;
  const { path: filePath, content, sha, message } = req.body;

  if (!filePath || !filePath.startsWith(`apps/${appName}/`)) {
    return res.status(400).json({ error: 'Chemin invalide.' });
  }
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Contenu vide.' });
  }
  const userAppNames = getUserAppNames(req.user);
  if (!userAppNames.has(appName)) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }

  const { owner, repo, token } = configRepo();
  const commitMsg = (message || '').trim() ||
    `chore(${appName}): update ${filePath.split('/').pop()} via CNP Portal [${req.user.username}]`;

  try {
    await githubService.createOrUpdateFileWithToken(
      owner, repo, filePath,
      content,
      commitMsg,
      token,
      sha || undefined
    );
    res.json({ ok: true, message: commitMsg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
