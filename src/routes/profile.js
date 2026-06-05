'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const userStore = require('../models/user');

const VALID_ROLES = ['manager', 'devops', 'dev'];

router.get('/', requireAuth, (req, res) => {
  res.render('profile', {
    title: 'Mon profil — CNP Portal',
    currentPage: 'profile',
    roles: VALID_ROLES,
  });
});

router.post('/role', requireAuth, (req, res) => {
  const { role } = req.body;
  if (!VALID_ROLES.includes(role)) {
    req.flash('error', 'Rôle invalide.');
    return res.redirect('/profile');
  }
  const updated = userStore.update(req.user.id, { role });
  req.session.role = updated.role;
  req.flash('success', `Rôle mis à jour : ${updated.role}`);
  res.redirect('/profile');
});

module.exports = router;
