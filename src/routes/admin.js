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

router.get('/users', requireAuth, requireRole('manager'), (req, res) => {
  const users = userStore.findAll();
  res.render('admin/users', {
    title: 'Gestion des utilisateurs — CNP Portal',
    currentPage: 'admin',
    users,
    user: req.user,
    can: (p) => can(req.user, p),
  });
});

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
    req.flash('success', `Rôle de ${updated.gitlabUsername} mis à jour: ${role}.`);
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle', requireAuth, requireRole('manager'), (req, res) => {
  const target = userStore.findById(req.params.id);
  if (!target) {
    req.flash('error', 'Utilisateur introuvable.');
    return res.redirect('/admin/users');
  }
  userStore.update(req.params.id, { active: !target.active });
  req.flash('success', `Utilisateur ${target.gitlabUsername} ${target.active ? 'désactivé' : 'réactivé'}.`);
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
