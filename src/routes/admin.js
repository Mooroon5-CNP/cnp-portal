'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requirePermission, requireRole, can } = require('../middleware/rbac');
const userStore = require('../models/user');

const MOCK_SECRETS = [
  { name: 'cnp-portal-prod-gitlab-oauth',    type: 'Opaque', namespace: 'cnp-portal', keys: ['GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET', 'GITLAB_REDIRECT_URI'] },
  { name: 'cnp-portal-prod-session-secret',  type: 'Opaque', namespace: 'cnp-portal', keys: ['SESSION_SECRET'] },
  { name: 'cnp-portal-prod-datadog-api-key', type: 'Opaque', namespace: 'cnp-portal', keys: ['DATADOG_API_KEY', 'DATADOG_APP_KEY'] },
  { name: 'cnp-portal-dev-gitlab-oauth',     type: 'Opaque', namespace: 'cnp-portal', keys: ['GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET', 'GITLAB_REDIRECT_URI'] },
];

// SSE: keep track of connected admin clients
const sseClients = new Map();

function broadcastPendingUpdate() {
  const pending = userStore.findPending();
  const payload = `data: ${JSON.stringify(pending)}\n\n`;
  for (const [, res] of sseClients) {
    res.write(payload);
  }
}

// User list — manager + devops
router.get('/users', requireAuth, requireRole('manager', 'devops'), (req, res) => {
  const users = userStore.findAll();
  res.render('admin/users', {
    title: 'Gestion des utilisateurs — CNP Portal',
    currentPage: 'admin',
    users,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

// SSE stream for live pending-user updates — manager + devops
router.get('/users/events', requireAuth, requireRole('manager', 'devops'), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  sseClients.set(clientId, res);

  // Send current pending list immediately on connect
  const pending = userStore.findPending();
  res.write(`data: ${JSON.stringify(pending)}\n\n`);

  // Heartbeat every 25s to keep connection alive through proxies
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(clientId);
  });
});

// Approve pending user — manager + devops
router.post('/users/:id/approve', requireAuth, requirePermission('users:approve'), (req, res) => {
  const target = userStore.findById(req.params.id);
  if (!target) {
    return res.status(404).json({ error: 'Utilisateur introuvable.' });
  }
  userStore.update(req.params.id, { active: true, approved: true });
  broadcastPendingUpdate();
  res.json({ ok: true, username: target.username });
});

// Change role — manager only
router.post('/users/:id/role', requireAuth, requireRole('manager'), (req, res) => {
  const { role } = req.body;
  const validRoles = ['manager', 'devops', 'dev'];
  if (!validRoles.includes(role)) {
    req.flash('error', 'Rôle invalide.');
    return res.redirect('/admin/users');
  }
  const updated = userStore.update(req.params.id, { role });
  if (!updated) {
    req.flash('error', 'Utilisateur introuvable.');
  } else {
    req.flash('success', `Rôle de ${updated.username} mis à jour : ${role}.`);
  }
  res.redirect('/admin/users');
});

// Toggle active — manager only
router.post('/users/:id/toggle', requireAuth, requireRole('manager'), (req, res) => {
  const target = userStore.findById(req.params.id);
  if (!target) {
    req.flash('error', 'Utilisateur introuvable.');
    return res.redirect('/admin/users');
  }
  userStore.update(req.params.id, { active: !target.active });
  req.flash('success', `Utilisateur ${target.username} ${target.active ? 'désactivé' : 'réactivé'}.`);
  res.redirect('/admin/users');
});

router.get('/secrets', requireAuth, requirePermission('secrets:view-names'), (req, res) => {
  res.render('admin/secrets', {
    title: 'Secrets — CNP Portal',
    currentPage: 'admin',
    secrets: MOCK_SECRETS,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

module.exports = router;
