'use strict';

const userStore = require('../models/user');

function populateUser(req, res, next) {
  if (req.session && req.session.userId) {
    req.user = userStore.findById(req.session.userId);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/auth/login');
  }
  next();
}

module.exports = { populateUser, requireAuth };
