'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth }       = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const argocdService  = require('../services/argocd');
const { config }     = require('../config/env');

// ── Main page ─────────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  // Managers see ALL pending requests (not filtered by team — any manager can approve)
  let accessRequests = [];
  if (can(req.user, 'argocd:access:approve')) {
    accessRequests = argocdService.getAccessRequests();
  }

  // Managers already have full access — don't show them the request workflow
  const isManager = req.user.role === 'manager';
  const myRequest = !isManager && can(req.user, 'argocd:access:request')
    ? argocdService.getUserAccessRequest(req.user.id)
    : null;

  // Apps list: only for users with an approved request (or managers who can see all)
  let apps = [];
  const hasAccess = can(req.user, 'argocd:apps:view-all')
    || (myRequest && myRequest.status === 'approved');

  if (hasAccess) {
    apps = await argocdService.listApps();
  }

  res.render('argocd/index', {
    title:          'ArgoCD — CNP Portal',
    currentPage:    'argocd',
    accessRequests,
    myRequest,
    apps,
    hasAccess,
    argoCDUiUrl:   config.argocd.uiUrl,
    user:  req.user,
    can:   (p) => can(req.user, p),
  });
});

// ── Sync ──────────────────────────────────────────────────────────────────────

router.post('/sync/:name', requireAuth, requirePermission('argocd:sync'), async (req, res) => {
  try {
    await argocdService.syncApp(req.params.name);
    req.flash('success', `Sync forcé pour ${req.params.name}.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

// ── Access request (devops / dev) ─────────────────────────────────────────────

router.post('/access-request', requireAuth, requirePermission('argocd:access:request'), async (req, res) => {
  const { appName, reason } = req.body;
  try {
    argocdService.requestAccess(req.user.id, appName, reason);
    req.flash('success', 'Demande d\'accès ArgoCD envoyée à votre manager.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

// ── Approve (manager) ─────────────────────────────────────────────────────────

router.post('/access-request/:id/approve', requireAuth, requirePermission('argocd:access:approve'), async (req, res) => {
  try {
    await argocdService.approveAccess(req.params.id, req.user.id);
    req.flash('success', 'Accès ArgoCD approuvé et compte créé.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

// ── Reject (manager) ──────────────────────────────────────────────────────────

router.post('/access-request/:id/reject', requireAuth, requirePermission('argocd:access:approve'), async (req, res) => {
  try {
    argocdService.rejectAccess(req.params.id, req.user.id);
    req.flash('success', 'Demande refusée.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

module.exports = router;
