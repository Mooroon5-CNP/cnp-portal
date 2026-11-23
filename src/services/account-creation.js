'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const userStore = require('../models/user');
const teamService = require('./teams');

const ROLES = ['manager', 'devops', 'dev'];
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
// No look-alike characters (0/O, 1/l/I) so the password survives being read aloud or retyped.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;
const DEFAULT_PORTAL_URL = 'https://portal.apps.mooroon5.fr';

class AccountError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function generatePassword() {
  let out = '';
  while (out.length < PASSWORD_LENGTH) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < 256 - (256 % ALPHABET.length)) out += ALPHABET[byte % ALPHABET.length]; // unbiased
  }
  return out;
}

const portalUrl = (env = process.env) => (env.PORTAL_PUBLIC_URL || DEFAULT_PORTAL_URL).replace(/\/+$/, '');

async function createManagedAccount({ username, role, teamId }) {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!USERNAME_PATTERN.test(name)) {
    throw new AccountError('Identifiant invalide : 3 à 32 caractères (lettres, chiffres, point, tiret, underscore).');
  }
  if (!ROLES.includes(role)) throw new AccountError('Rôle invalide.');
  if (teamId && !teamService.getTeam(teamId)) throw new AccountError('Équipe introuvable.');
  if (userStore.findByUsername(name)) throw new AccountError('Cet identifiant existe déjà.', 409);
  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 12);
  const created = userStore.create({ username: name, passwordHash, role, active: 1, approved: 1, mustChangePassword: true });
  if (teamId) teamService.addMember(teamId, created.id);
  return { user: created, credentials: { username: name, password, url: portalUrl() } };
}

module.exports = { createManagedAccount, generatePassword, AccountError, ROLES, portalUrl };
