'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

function rowToUser(row) {
  if (!row) return null;
  return {
    id:            row.id,
    gitlabId:      row.gitlab_id,
    username:      row.username,
    gitlabUsername: row.username,  // backward-compat alias
    email:         row.email,
    avatarUrl:     row.avatar_url,
    passwordHash:  row.password_hash,
    role:          row.role,
    active:        row.active === 1,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
  };
}

function findById(id) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function findByGitlabId(gitlabId) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE gitlab_id = ?').get(gitlabId));
}

function findByUsername(username) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function findAll() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(rowToUser);
}

function create({ gitlabId = null, username, email = null, avatarUrl = null, passwordHash = null, role = 'dev' }) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, gitlab_id, username, email, avatar_url, password_hash, role, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, gitlabId, username, email, avatarUrl, passwordHash, role, now, now);
  return findById(id);
}

function update(id, fields) {
  if (!findById(id)) return null;
  const now = new Date().toISOString();
  const colMap = { username: 'username', email: 'email', avatarUrl: 'avatar_url', role: 'role', active: 'active' };
  const sets = ['updated_at = ?'];
  const values = [now];
  for (const [jsKey, col] of Object.entries(colMap)) {
    if (fields[jsKey] !== undefined) {
      sets.push(`${col} = ?`);
      const v = fields[jsKey];
      values.push(v === true ? 1 : v === false ? 0 : v);
    }
  }
  values.push(id);
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return findById(id);
}

function upsertFromGitlab({ gitlabId, gitlabUsername, email, avatarUrl }) {
  let user = findByGitlabId(gitlabId);
  if (user) {
    return update(user.id, { username: gitlabUsername, email, avatarUrl });
  }
  const taken = findByUsername(gitlabUsername);
  const username = taken ? `${gitlabUsername}_gl` : gitlabUsername;
  return create({ gitlabId, username, email, avatarUrl });
}

module.exports = { findById, findByGitlabId, findByUsername, findAll, create, update, upsertFromGitlab };
