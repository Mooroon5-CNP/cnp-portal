'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const argocdService = require('../services/argocd');

router.get('/', requireAuth, requirePermission('argocd:apps:view-own'), async (req, res) => {
  const canViewAll = can(req.user, 'argocd:apps:view-all');
  const apps = await argocdService.listApps(canViewAll ? null : req.user.gitlabUsername);
  const accessRequests = can(req.user, 'argocd:access:approve')
    ? await argocdService.getAccessRequests()
    : [];

  res.render('argocd/index', {
    title: 'ArgoCD — CNP Portal',
    currentPage: 'argocd',
    apps,
    accessRequests,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.post('/sync/:name', requireAuth, requirePermission('argocd:sync'), async (req, res) => {
  try {
    await argocdService.syncApp(req.params.name);
    req.flash('success', `Sync forcé pour ${req.params.name}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

router.post('/access-request', requireAuth, requirePermission('argocd:access:request'), async (req, res) => {
  const { appName, reason } = req.body;
  await argocdService.requestAccess(req.user.id, appName, reason);
  req.flash('success', 'Demande d\'accès ArgoCD envoyée au manager.');
  res.redirect('/argocd');
});

router.post('/access-request/:index/approve', requireAuth, requirePermission('argocd:access:approve'), async (req, res) => {
  try {
    await argocdService.approveAccess(parseInt(req.params.index));
    req.flash('success', 'Accès ArgoCD approuvé.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

module.exports = router;
