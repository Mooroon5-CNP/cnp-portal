'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const argocdService = require('../services/argocd');
const teamService = require('../services/teams');

router.get('/', requireAuth, async (req, res) => {
  let accessRequests = [];
  if (can(req.user, 'argocd:access:approve')) {
    const myTeamMemberIds = teamService.getTeamMemberIds(req.user.id);
    const all = await argocdService.getAccessRequests();
    accessRequests = all.filter(r => myTeamMemberIds.has(r.userId));
  }

  res.render('argocd/index', {
    title: 'ArgoCD — CNP Portal',
    currentPage: 'argocd',
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
