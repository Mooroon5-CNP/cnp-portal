'use strict';

const { v4: uuidv4 } = require('uuid');

// In-memory user store. Post-MVP: replace with PostgreSQL.
const users = new Map();

function findById(id) {
  return users.get(id) || null;
}

function findByGitlabId(gitlabId) {
  for (const user of users.values()) {
    if (user.gitlabId === gitlabId) return user;
  }
  return null;
}

function findAll() {
  return Array.from(users.values());
}

function create({ gitlabId, gitlabUsername, email, avatarUrl }) {
  const id = uuidv4();
  const user = {
    id,
    gitlabId,
    gitlabUsername,
    email,
    avatarUrl,
    role: 'dev',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
  };
  users.set(id, user);
  return user;
}

function update(id, fields) {
  const user = users.get(id);
  if (!user) return null;
  const allowed = ['gitlabUsername', 'email', 'avatarUrl', 'role', 'active'];
  for (const key of allowed) {
    if (fields[key] !== undefined) user[key] = fields[key];
  }
  user.updatedAt = new Date().toISOString();
  return user;
}

function upsertFromGitlab({ gitlabId, gitlabUsername, email, avatarUrl }) {
  let user = findByGitlabId(gitlabId);
  if (user) {
    return update(user.id, { gitlabUsername, email, avatarUrl });
  }
  return create({ gitlabId, gitlabUsername, email, avatarUrl });
}

module.exports = { findById, findByGitlabId, findAll, create, update, upsertFromGitlab };
