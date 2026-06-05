'use strict';

const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const router = express.Router();
const userStore = require('../models/user');
const tokenStore = require('../models/tokenStore');
const gitlabService = require('../services/gitlab');

const GITLAB_HOST = process.env.GITLAB_HOST || 'https://gitlab.cri.epita.fr';
const GITLAB_AUTH_URL = `${GITLAB_HOST}/oauth/authorize`;
const GITLAB_TOKEN_URL = `${GITLAB_HOST}/oauth/token`;
const SCOPES = 'read_user api read_repository';

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Connexion — CNP Portal', user: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    req.flash('error', 'Identifiant et mot de passe requis.');
    return res.redirect('/auth/login');
  }
  const user = userStore.findByUsername(username.trim());
  if (!user || !user.passwordHash) {
    req.flash('error', 'Identifiant ou mot de passe incorrect.');
    return res.redirect('/auth/login');
  }
  if (!user.active) {
    req.flash('error', 'Ce compte est désactivé.');
    return res.redirect('/auth/login');
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    req.flash('error', 'Identifiant ou mot de passe incorrect.');
    return res.redirect('/auth/login');
  }
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.gitlabUsername = user.username;
  res.redirect('/');
});

router.get('/gitlab', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.GITLAB_CLIENT_ID,
    redirect_uri: process.env.GITLAB_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state: require('crypto').randomBytes(16).toString('hex'),
  });
  res.redirect(`${GITLAB_AUTH_URL}?${params.toString()}`);
});

router.get('/gitlab/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    req.flash('error', `Erreur GitLab: ${error}`);
    return res.redirect('/auth/login');
  }

  try {
    const tokenResponse = await axios.post(GITLAB_TOKEN_URL, {
      client_id: process.env.GITLAB_CLIENT_ID,
      client_secret: process.env.GITLAB_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.GITLAB_REDIRECT_URI,
    });

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    const gitlabUser = await gitlabService.getUser(access_token);

    const user = userStore.upsertFromGitlab({
      gitlabId: gitlabUser.id,
      gitlabUsername: gitlabUser.username,
      email: gitlabUser.email,
      avatarUrl: gitlabUser.avatar_url,
    });

    tokenStore.set(user.id, {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: expires_in ? new Date(Date.now() + expires_in * 1000).toISOString() : null,
    });

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.gitlabUsername = user.gitlabUsername;

    res.redirect('/');
  } catch (err) {
    req.flash('error', 'Échec de l\'authentification GitLab. Veuillez réessayer.');
    res.redirect('/auth/login');
  }
});

router.post('/logout', (req, res) => {
  const userId = req.session && req.session.userId;
  if (userId) tokenStore.remove(userId);
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

router.get('/logout', (req, res) => {
  const userId = req.session && req.session.userId;
  if (userId) tokenStore.remove(userId);
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
