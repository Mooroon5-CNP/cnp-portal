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
  if (req.user && !req.user.active) {
    return res.redirect('/pending');
  }
  next();
}

function requirePending(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/auth/login');
  }
  if (req.user && req.user.active) {
    return res.redirect('/');
  }
  next();
}

module.exports = { populateUser, requireAuth, requirePending };
