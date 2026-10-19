'use strict';

const express = require('express');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const router = express.Router();
const userStore = require('../models/user');
const tokenStore = require('../models/tokenStore');

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';

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
  req.session.username = user.username;
  res.redirect('/');
});

router.get('/github', (req, res) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    req.flash('error', 'GitHub OAuth non configuré. Ajoutez GITHUB_CLIENT_ID et GITHUB_CLIENT_SECRET dans votre .env.');
    return res.redirect('/auth/login');
  }
  const state = require('crypto').randomBytes(16).toString('hex');
  req.session.githubOAuthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_REDIRECT_URI,
    scope: 'read:user user:email',
    state,
  });
  res.redirect(`${GITHUB_AUTH_URL}?${params.toString()}`);
});

router.get('/github/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    req.flash('error', `Erreur GitHub: ${error}`);
    return res.redirect('/auth/login');
  }

  if (!state || state !== req.session.githubOAuthState) {
    req.flash('error', 'État OAuth invalide. Veuillez réessayer.');
    return res.redirect('/auth/login');
  }
  delete req.session.githubOAuthState;

  try {
    const tokenResponse = await axios.post(GITHUB_TOKEN_URL, {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: process.env.GITHUB_REDIRECT_URI,
    }, { headers: { Accept: 'application/json' } });

    const { access_token } = tokenResponse.data;
    if (!access_token) throw new Error('No access token returned');

    const [profileRes, emailsRes] = await Promise.all([
      axios.get(`${GITHUB_API_URL}/user`, { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'CNP-Portal' } }),
      axios.get(`${GITHUB_API_URL}/user/emails`, { headers: { Authorization: `Bearer ${access_token}`, 'User-Agent': 'CNP-Portal' } }),
    ]);

    const profile = profileRes.data;
    const primaryEmail = emailsRes.data.find(e => e.primary && e.verified)?.email || profile.email || null;

    const user = userStore.upsertFromGithub({
      githubId: profile.id,
      githubUsername: profile.login,
      email: primaryEmail,
      avatarUrl: profile.avatar_url,
    });

    tokenStore.set(user.id, { accessToken: access_token, refreshToken: null, expiresAt: null });

    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.username = user.username;

    res.redirect('/');
  } catch (err) {
    req.flash('error', 'Échec de l\'authentification GitHub. Veuillez réessayer.');
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
