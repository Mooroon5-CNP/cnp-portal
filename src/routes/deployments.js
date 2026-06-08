'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const githubService = require('../services/github');
const deploymentModel = require('../models/deployment');
const yaml = require('js-yaml');

function mapRunToStatus(run) {
  if (!run) return { label: 'En attente', badge: 'badge-gray' };
  if (run.status === 'in_progress') return { label: 'CI en cours', badge: 'badge-warning' };
  if (run.status === 'completed') {
    if (run.conclusion === 'success') return { label: 'Déployé', badge: 'badge-success' };
    if (run.conclusion === 'failure') return { label: 'Échec CI', badge: 'badge-danger' };
    if (run.conclusion === 'cancelled') return { label: 'Annulé', badge: 'badge-gray' };
  }
  return { label: 'En attente', badge: 'badge-gray' };
}

async function readDeployedTag(appName, token) {
  try {
    const path = `apps/${appName}/overlays/dev/kustomization.yaml`;
    const content = await githubService.getFileContent('Mooroon5-CNP', 'config-repo', path, token).catch(() => null);
    if (!content) return null;
    const doc = yaml.load(content);
    if (doc && doc.images && Array.isArray(doc.images)) {
      for (const i of doc.images) {
        if (i && i.newTag) return String(i.newTag).slice(0, 7);
      }
    }
    // fallback: look for newTag in text
    const m = content.match(/newTag:\s*["']?([a-f0-9]{7,40})["']?/i);
    if (m) return m[1].slice(0, 7);
  } catch (e) {
    // ignore
  }
  return null;
}

router.get('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
  const rows = deploymentModel.listForUser(req.user);

  const enriched = await Promise.all(rows.map(async (r) => {
    const d = deploymentModel.get(r.id);
    const token = d.configRepoToken; // decrypted by model.get
    let run = null;
    try { run = await githubService.getLatestRun(d.githubRepoUrl, token); } catch (e) { run = null; }
    const status = mapRunToStatus(run);
    const branch = run ? (run.head_branch || run.head_branch || 'main') : 'main';
    const lastRunTime = run ? (run.updated_at || run.run_started_at || run.created_at) : null;
    const deployedTag = await readDeployedTag(d.appName, token);
    return {
      id: d.id,
      appName: d.appName,
      githubRepoUrl: d.githubRepoUrl,
      appPort: d.appPort,
      status,
      branch,
      lastRunTime,
      deployedTag,
      ownerUserId: d.ownerUserId,
    };
  }));

  res.render('deployments/index', {
    title: 'Déploiements — CNP Portal',
    currentPage: 'deployments',
    deployments: enriched,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.post('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
  const { appName, githubRepoUrl, appPort, configRepoToken } = req.body;
  if (!appName || !githubRepoUrl || !configRepoToken) {
    req.flash('error', 'Veuillez renseigner le nom de l\'application, l\'URL du repo et le token CONFIG_REPO_TOKEN.');
    return res.redirect('/deployments');
  }

  // Validate GitHub repo is reachable
  try {
    await githubService.getRepo(githubRepoUrl, configRepoToken);
  } catch (e) {
    req.flash('error', 'Impossible de contacter le dépôt GitHub avec le token fourni.');
    return res.redirect('/deployments');
  }

  // Validate config-repo path exists
  const path = `apps/${appName}/overlays/dev/kustomization.yaml`;
  const ok = await githubService.pathExists('Mooroon5-CNP', 'config-repo', path, configRepoToken);
  if (!ok) {
    req.flash('error', `Le chemin ${path} est introuvable dans Mooroon5-CNP/config-repo.`);
    return res.redirect('/deployments');
  }

  try {
    deploymentModel.create({ appName, githubRepoUrl, appPort: parseInt(appPort, 10) || null, configRepoToken, ownerUserId: req.user.id });
    req.flash('success', `Déploiement ${appName} enregistré — statut: En attente.`);
  } catch (e) {
    req.flash('error', 'Impossible d\'enregistrer le déploiement.');
  }
  return res.redirect('/deployments');
});

router.post('/:id/delete', requireAuth, requirePermission('deployments:delete'), (req, res) => {
  const dep = deploymentModel.get(req.params.id);
  if (!dep) {
    req.flash('error', 'Déploiement introuvable.');
    return res.redirect('/deployments');
  }
  const canViewAll = can(req.user, 'k8s:pods:view-all');
  if (!canViewAll && dep.ownerUserId !== req.user.id) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  deploymentModel.delete(req.params.id);
  req.flash('success', 'Déploiement supprimé.');
  return res.redirect('/deployments');
});

router.get('/:id', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
  const dep = deploymentModel.get(req.params.id);
  if (!dep) return res.status(404).send('Déploiement introuvable');

  const token = dep.configRepoToken;
  const runs = await githubService.getRuns(dep.githubRepoUrl, token, 5).catch(() => []);
  const latest = runs && runs.length > 0 ? runs[0] : null;
  let jobs = [];
  if (latest) {
    jobs = await githubService.getRunJobs(dep.githubRepoUrl, latest.id, token).catch(() => []);
  }

  // Failure hint mapping
  const hintMap = {
    'lint-eslint': 'ESLint error in source code. Check `npm run lint` locally.',
    'lint-hadolint': 'Dockerfile violates CNP rules (must use node:20-alpine, non-root user).',
    'test': 'Unit tests failed. Check `npm test` locally.',
    'scan-secrets': 'Committed secret detected in git history. See Gitleaks report in artifacts.',
    'scan-deps': 'CRITICAL CVE in npm dependencies. Run `npm audit` then update the affected package.',
    'build': 'Docker image build failed (Kaniko). Check Dockerfile syntax and base image availability.',
    'scan-image': 'CRITICAL CVE in built image. The image may have been deleted from ghcr.io.',
    'update-config-dev': 'Could not push to config-repo. Verify CONFIG_REPO_TOKEN has write access to Mooroon5-CNP/config-repo.',
    'update-config-prod': 'Waiting for manual approval in GitHub Actions. Review deployment in Actions.'
  };

  let failureHint = null;
  if (latest && latest.conclusion === 'failure' && Array.isArray(jobs)) {
    const firstFailed = jobs.find(j => j.conclusion === 'failure');
    if (firstFailed) {
      const key = String(firstFailed.name || '').toLowerCase();
      failureHint = hintMap[key] || `Job ${firstFailed.name} failed.`;
    }
  }

  // Parse repo URL to build link
  const repoParts = githubService.parseRepoUrl(dep.githubRepoUrl) || {};
  const githubActionsUrl = latest ? `https://github.com/${repoParts.owner}/${repoParts.repo}/actions/runs/${latest.id}` : null;

  const safeDeployment = {
    id: dep.id,
    appName: dep.appName,
    githubRepoUrl: dep.githubRepoUrl,
    appPort: dep.appPort,
    ownerUserId: dep.ownerUserId,
    createdAt: dep.createdAt,
    updatedAt: dep.updatedAt,
  };

  res.render('deployments/detail', {
    title: `Déploiement — ${dep.appName}`,
    currentPage: 'deployments',
    deployment: safeDeployment,
    runs,
    latest,
    jobs,
    failureHint,
    githubActionsUrl,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

module.exports = router;
