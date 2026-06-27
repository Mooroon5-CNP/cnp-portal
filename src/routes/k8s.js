'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const k8sService = require('../services/k8s');
const deploymentModel = require('../models/deployment');
const teamService = require('../services/teams');
const githubService = require('../services/github');
const manifestMrModel = require('../models/manifest_mr');
const { config } = require('../config/env');

// Resolve config-repo owner/repo from "owner/repo" env var.
function configRepo() {
  const parts = (config.github.configRepoName || '').split('/');
  return { owner: parts[0] || '', repo: parts[1] || '', token: config.github.configRepoToken };
}

// Returns { visible: Set<appName>, editable: Set<appName> }
// visible = user can see pods/quotas for these apps
// editable = user's team has WRITE access (or ownership) → Edit YAML button
function getUserAppSets(user) {
  const teams = teamService.getTeamsForUser(user.id);
  const teamIds = new Set(teams.map(t => t.id));
  const rows = deploymentModel.listForUser(user);
  const isManager = user.role === 'manager';

  if (isManager) {
    const all = new Set(rows.map(d => d.app_name));
    return { visible: all, editable: all };
  }

  const visible  = new Set();
  const editable = new Set();

  for (const d of rows) {
    const isOwner = d.owner_user_id === user.id ||
                    (d.owner_team_id && teamIds.has(d.owner_team_id));

    // Determine if user's team has been granted write access.
    const writeTeamIds = deploymentModel.getTeamIdsWithWriteAccess(d.id);
    const hasWriteGrant = writeTeamIds.some(tid => teamIds.has(tid));

    if (isOwner || hasWriteGrant) {
      visible.add(d.app_name);
      editable.add(d.app_name);
    } else {
      // Check read-only granted access.
      const accessTeamIds = deploymentModel.getAccessibleTeamIds(d.id);
      if (accessTeamIds.some(tid => teamIds.has(tid))) {
        visible.add(d.app_name);
        // No write → not in editable
      }
    }
  }

  return { visible, editable };
}

// ── Pods / quotas / events ────────────────────────────────────────────────────

router.get('/pods', requireAuth, requirePermission('k8s:pods:view-own'), async (req, res) => {
  const isManager = req.user.role === 'manager';
  const { visible, editable } = getUserAppSets(req.user);

  function podInScope(pod) {
    if (isManager) return true;
    return visible.has(pod.app) ||
           visible.has((pod.namespace || '').replace(/-dev$|-prod$/, ''));
  }
  function quotaInScope(q) {
    if (isManager) return true;
    return [...visible].some(n => (q.namespace || '').startsWith(n));
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
    userAppNames:    [...visible],
    editableAppNames: [...editable],
    can: (p) => can(req.user, p),
  });
});

router.post('/pods/:name/delete', requireAuth, requirePermission('k8s:pods:delete'), async (req, res) => {
  const namespace = req.body.namespace;
  if (!namespace) {
    req.flash('error', 'Namespace manquant.');
    return res.redirect('/k8s/pods');
  }
  if (req.user.role !== 'manager') {
    const appName = namespace.replace(/-dev$|-prod$/, '');
    const { editable } = getUserAppSets(req.user);
    if (!editable.has(appName)) {
      req.flash('error', 'Accès refusé : votre équipe n\'a pas l\'accès en écriture sur cette application.');
      return res.redirect('/k8s/pods');
    }
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
  if (req.user.role !== 'manager') {
    const { editable } = getUserAppSets(req.user);
    if (!editable.has(req.params.name)) {
      req.flash('error', 'Accès refusé : votre équipe n\'a pas l\'accès en écriture sur cette application.');
      return res.redirect('/k8s/pods');
    }
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
  const { editable } = getUserAppSets(req.user);
  if (!editable.has(appName)) {
    req.flash('error', 'Accès refusé : votre équipe n\'a pas l\'accès en écriture sur cette application.');
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
  const { editable } = getUserAppSets(req.user);
  if (!editable.has(appName)) {
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

// POST /k8s/apps/:appName/file — create a PR instead of committing directly
router.post('/apps/:appName/file', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const { appName }               = req.params;
  const { path: filePath, content, sha, message, deploymentId } = req.body;

  if (!filePath || !filePath.startsWith(`apps/${appName}/`)) {
    return res.status(400).json({ error: 'Chemin invalide.' });
  }
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Contenu vide.' });
  }
  const { editable } = getUserAppSets(req.user);
  if (!editable.has(appName)) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }

  const { owner, repo, token } = configRepo();
  const fileName = filePath.split('/').pop();
  const commitMsg = (message || '').trim() ||
    `chore(${appName}): update ${fileName} via CNP Portal [${req.user.username}]`;

  // Derive the deploymentId if not provided.
  const resolvedDeploymentId = deploymentId || (() => {
    const rows = deploymentModel.listForUser(req.user);
    const match = rows.find(r => r.app_name === appName);
    return match ? match.id : null;
  })();

  try {
    // Create a dedicated branch for this edit.
    const branchName = `manifest-edit/${appName}/${Date.now()}`;
    await githubService.createBranchWithToken(owner, repo, branchName, token);

    // Commit the file on the new branch.
    // sha is for the file on main; on the fresh branch the file exists with the same sha.
    await githubService.createOrUpdateFileOnBranch(
      owner, repo, filePath, content, commitMsg, token, branchName, sha || undefined
    );

    // Open a PR from the new branch to main.
    const prTitle = `[CNP] ${appName} — ${fileName} (${req.user.username})`;
    const prBody = `Modification de \`${filePath}\` demandée par **${req.user.username}** via CNP Portal.\n\n> ${commitMsg}`;
    const { number: prNumber, html_url: prUrl } = await githubService.createPullRequest(
      owner, repo, prTitle, prBody, branchName, 'main', token
    );

    // Persist in DB.
    const mr = manifestMrModel.create({
      deploymentId: resolvedDeploymentId,
      appName,
      filePath,
      branchName,
      prNumber,
      prUrl,
      commitMessage: commitMsg,
      requestedBy: req.user.id,
    });

    res.json({ ok: true, mrId: mr.id, prUrl, message: 'Pull Request créée — en attente de validation manager.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Manifest MR management (DevOps) ──────────────────────────────────────────

// GET /k8s/manifest-prs — DevOps sees their submitted MRs (synced from GitHub)
router.get('/manifest-prs', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const pendingToSync = manifestMrModel.listForUser(req.user.id).filter(m => m.status === 'pending');
  if (pendingToSync.length) {
    const { owner, repo, token } = configRepo();
    await Promise.all(pendingToSync.map(async (mr) => {
      if (!mr.prNumber) return;
      try {
        const status = await githubService.getPullRequestStatus(owner, repo, mr.prNumber, token);
        if (!status) return;
        if (status.merged) {
          manifestMrModel.approve(mr.id, 'github');
        } else if (status.state === 'closed' && !status.merged) {
          manifestMrModel.reject(mr.id, 'github', 'PR fermée directement sur GitHub');
        }
      } catch (_) { /* PR status unavailable */ }
    }));
  }

  const mrs = manifestMrModel.listForUser(req.user.id);
  res.render('k8s/mr-list', {
    title: 'Mes Pull Requests — CNP Portal',
    currentPage: 'manifest-prs',
    mrs,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

// GET /k8s/manifest-prs/:id/edit — DevOps edits a rejected MR
router.get('/manifest-prs/:id/edit', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const mr = manifestMrModel.get(req.params.id);
  if (!mr || mr.requestedBy !== req.user.id) {
    req.flash('error', 'MR introuvable.');
    return res.redirect('/k8s/manifest-prs');
  }
  if (mr.status !== 'rejected') {
    req.flash('error', 'Seules les MRs rejetées peuvent être modifiées.');
    return res.redirect('/k8s/manifest-prs');
  }

  const { owner, repo, token } = configRepo();
  const file = await githubService.getFileOnBranch(owner, repo, mr.filePath, token, mr.branchName);

  res.render('k8s/mr-edit', {
    title: `Modifier MR — ${mr.appName}`,
    currentPage: 'k8s',
    mr,
    fileContent: file ? file.content : '',
    fileSha: file ? file.sha : null,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

// POST /k8s/manifest-prs/:id/resubmit — DevOps pushes a new commit on the same branch
router.post('/manifest-prs/:id/resubmit', requireAuth, requirePermission('k8s:manifest:edit'), async (req, res) => {
  const mr = manifestMrModel.get(req.params.id);
  if (!mr || mr.requestedBy !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé.' });
  }
  if (mr.status !== 'rejected') {
    return res.status(400).json({ error: 'Seules les MRs rejetées peuvent être resoumises.' });
  }

  const { content, sha, message } = req.body;
  if (!content || content.trim() === '') {
    return res.status(400).json({ error: 'Contenu vide.' });
  }

  const { owner, repo, token } = configRepo();
  const commitMsg = (message || '').trim() || mr.commitMessage;

  try {
    await githubService.createOrUpdateFileOnBranch(
      owner, repo, mr.filePath, content, commitMsg, token, mr.branchName, sha || undefined
    );
    manifestMrModel.resubmit(mr.id);
    res.json({ ok: true, message: 'MR resoumise — en attente de validation manager.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
