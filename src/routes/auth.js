'use strict';

const express = require('express');
const axios = require('axios');
const router = express.Router();
const userStore = require('../models/user');
const tokenStore = require('../models/tokenStore');
const gitlabService = require('../services/gitlab');

const GITLAB_AUTH_URL = 'https://gitlab.com/oauth/authorize';
const GITLAB_TOKEN_URL = 'https://gitlab.com/oauth/token';
const SCOPES = 'read_user api read_repository';

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Connexion — CNP Portal', user: null });
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
