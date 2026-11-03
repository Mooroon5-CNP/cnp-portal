'use strict';

const express = require('express');
const router  = express.Router();
const { requireAuth }       = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const argocdService  = require('../services/argocd');
const { config }     = require('../config/env');

// ── Main page ─────────────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
  // Only expose requests this reviewer may actually approve or reject.
  let accessRequests = [];
  if (can(req.user, 'argocd:access:approve')) {
    accessRequests = argocdService.getAccessRequests(req.user.id);
  }

  // Portal permissions do not imply a personal Argo CD account. Resolve the
  // caller's request for managers too, so approved credentials are not hidden.
  const myRequest = can(req.user, 'argocd:access:request')
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
    req.flash('success', req.user.role === 'manager'
      ? 'Demande d’accès ArgoCD envoyée au compte administrateur local admin pour validation.'
      : 'Demande d’accès ArgoCD envoyée à votre manager pour validation.');
    return res.redirect('/argocd');
  } catch (err) {
    if (err.message === 'ALREADY_APPROVED') {
      req.flash('info', 'Vous avez déjà un accès ArgoCD approuvé.');
      return res.redirect('/argocd?voir=identifiants');
    }
    req.flash('error', err.message);
    res.redirect('/argocd');
  }
});

// ── Approve (manager) ─────────────────────────────────────────────────────────

router.post('/access-request/:id/approve', requireAuth, requirePermission('argocd:access:approve'), async (req, res) => {
  try {
    await argocdService.approveAccess(req.params.id, req.user.id);
    req.flash('success', 'Accès ArgoCD approuvé et compte créé.');
  } catch (err) {
    if (err.code === 'FORBIDDEN') return res.status(403).render('error', { title: 'Accès refusé', message: err.message, code: 403, user: req.user });
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

// ── Regenerate credentials (approved user, self-service) ──────────────────────

router.post('/credentials/regenerate', requireAuth, requirePermission('argocd:access:request'), async (req, res) => {
  try {
    await argocdService.regenerateCredentials(req.user.id);
    req.flash('success', 'Identifiants ArgoCD régénérés avec succès.');
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
    if (err.code === 'FORBIDDEN') return res.status(403).render('error', { title: 'Accès refusé', message: err.message, code: 403, user: req.user });
    req.flash('error', err.message);
  }
  res.redirect('/argocd');
});

module.exports = router;
