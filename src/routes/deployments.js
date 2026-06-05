'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const gitlabService = require('../services/gitlab');

const deployments = [
  { id: 'dep-001', app: 'cnp-portal', cloud: 'GCP', replicas: 2, status: 'running', gitlabRepo: 'cnp/cnp-portal', deployedAt: new Date(Date.now() - 86400000).toISOString(), owner: null },
  { id: 'dep-002', app: 'app-alpha',  cloud: 'AWS', replicas: 1, status: 'running', gitlabRepo: 'alice/app-alpha', deployedAt: new Date(Date.now() - 3600000).toISOString(),  owner: 'alice' },
  { id: 'dep-003', app: 'app-beta',   cloud: 'OpenStack', replicas: 1, status: 'failed', gitlabRepo: 'bob/app-beta', deployedAt: new Date(Date.now() - 7200000).toISOString(), owner: 'bob' },
];

router.get('/', requireAuth, requirePermission('deployments:deploy'), (req, res) => {
  const canViewAll = can(req.user, 'k8s:pods:view-all');
  const list = canViewAll
    ? deployments
    : deployments.filter(d => d.owner === req.user.gitlabUsername || d.owner === null);

  res.render('deployments/index', {
    title: 'Déploiements — CNP Portal',
    currentPage: 'deployments',
    deployments: list,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.get('/new', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
  let repos = [];
  try {
    repos = await gitlabService.getProjects(req.user.id);
  } catch (_) {
    repos = [];
  }

  res.render('deployments/new', {
    title: 'Nouveau déploiement — CNP Portal',
    currentPage: 'deployments',
    repos,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.post('/', requireAuth, requirePermission('deployments:deploy'), async (req, res) => {
  const { repoId, repoName, cloud, replicas, ref } = req.body;

  const canChooseCloud = can(req.user, 'deployments:choose-cloud');
  const canChooseReplicas = can(req.user, 'deployments:choose-replicas');

  const deployment = {
    id: `dep-${Date.now()}`,
    app: repoName || repoId,
    cloud: canChooseCloud ? (cloud || 'GCP') : 'GCP',
    replicas: canChooseReplicas ? parseInt(replicas) || 1 : 1,
    status: 'pending',
    gitlabRepo: repoName,
    deployedAt: new Date().toISOString(),
    owner: req.user.gitlabUsername,
  };

  deployments.push(deployment);

  try {
    if (repoId) await gitlabService.triggerPipeline(req.user.id, repoId, ref || 'main');
  } catch (_) {}

  req.flash('success', `Déploiement de ${deployment.app} initié.`);
  res.redirect('/deployments');
});

router.post('/:id/delete', requireAuth, requirePermission('deployments:delete'), (req, res) => {
  const idx = deployments.findIndex(d => d.id === req.params.id);
  if (idx !== -1) {
    const dep = deployments[idx];
    const canViewAll = can(req.user, 'k8s:pods:view-all');
    if (!canViewAll && dep.owner !== req.user.gitlabUsername) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    deployments.splice(idx, 1);
  }
  req.flash('success', 'Déploiement supprimé.');
  res.redirect('/deployments');
});

module.exports = router;
