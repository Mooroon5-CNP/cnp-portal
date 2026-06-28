'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, can } = require('../middleware/rbac');
const datadogService = require('../services/datadog');
const teamService = require('../services/teams');

router.get('/datadog', requireAuth, async (req, res) => {
  let accessRequests = [];
  if (can(req.user, 'observability:access:approve')) {
    const myTeamMemberIds = teamService.getTeamMemberIds(req.user.id);
    const all = await datadogService.getAccessRequests();
    accessRequests = all.filter(r => myTeamMemberIds.has(r.userId));
  }

  res.render('observability/datadog', {
    title: 'DataDog — CNP Portal',
    currentPage: 'observability',
    accessRequests,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.get('/logs', requireAuth, requirePermission('observability:logs:own'), async (req, res) => {
  const canViewAll = can(req.user, 'observability:logs:all');
  const logs = await datadogService.getLogs(canViewAll ? null : req.user.gitlabUsername);

  res.render('observability/logs', {
    title: 'Logs — CNP Portal',
    currentPage: 'observability',
    logs,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.get('/metrics', requireAuth, requirePermission('observability:metrics:view'), async (req, res) => {
  const metrics = await datadogService.getMetrics();

  res.render('observability/metrics', {
    title: 'Métriques — CNP Portal',
    currentPage: 'observability',
    metrics,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.get('/alerts', requireAuth, requirePermission('observability:metrics:view'), async (req, res) => {
  const canViewAll = can(req.user, 'observability:logs:all');
  const alerts = await datadogService.getAlerts(canViewAll ? null : req.user.gitlabUsername);
  const accessRequests = can(req.user, 'observability:access:approve')
    ? await datadogService.getAccessRequests()
    : [];

  res.render('observability/alerts', {
    title: 'Alertes — CNP Portal',
    currentPage: 'observability',
    alerts,
    accessRequests,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

router.post('/alerts/:id/silence', requireAuth, requirePermission('observability:alerts:silence'), async (req, res) => {
  try {
    await datadogService.silenceAlert(req.params.id);
    req.flash('success', 'Alerte silencée.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/observability/alerts');
});

router.post('/alerts', requireAuth, requirePermission('observability:alerts:create'), async (req, res) => {
  const { name, query, app } = req.body;
  try {
    await datadogService.createAlert({ name, query, app });
    req.flash('success', `Alerte "${name}" créée.`);
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/observability/alerts');
});

router.post('/access-request', requireAuth, requirePermission('observability:access:request'), async (req, res) => {
  await datadogService.requestAccess(req.user.id, req.body.reason);
  req.flash('success', 'Demande d\'accès Datadog envoyée au manager.');
  res.redirect('/observability/logs');
});

router.post('/access-request/:index/approve', requireAuth, requirePermission('observability:access:approve'), async (req, res) => {
  try {
    await datadogService.approveAccess(parseInt(req.params.index));
    req.flash('success', 'Accès approuvé.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect('/observability/alerts');
});

// Per-app monitor silence/unsilence — used from the deployment detail observability tab.
// Accepts a `redirectTo` body field to redirect back to the calling page.
router.post('/monitors/:id/silence', requireAuth, requirePermission('observability:alerts:silence'), async (req, res) => {
  const redirectTo = (req.body.redirectTo || '').startsWith('/') ? req.body.redirectTo : '/observability/alerts';
  try {
    await datadogService.silenceAlert(req.params.id);
    req.flash('success', 'Alerte silencée.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(redirectTo);
});

router.post('/monitors/:id/unsilence', requireAuth, requirePermission('observability:alerts:silence'), async (req, res) => {
  const redirectTo = (req.body.redirectTo || '').startsWith('/') ? req.body.redirectTo : '/observability/alerts';
  try {
    await datadogService.unsilenceAlert(req.params.id);
    req.flash('success', 'Alerte réactivée.');
  } catch (err) {
    req.flash('error', err.message);
  }
  res.redirect(redirectTo);
});

module.exports = router;
