'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('./db');

function rowToUser(row) {
  if (!row) return null;
  return {
    id:             row.id,
    gitlabId:       row.gitlab_id,
    githubId:       row.github_id,
    username:       row.username,
    gitlabUsername: row.username,  // backward-compat alias
    email:          row.email,
    avatarUrl:      row.avatar_url,
    passwordHash:   row.password_hash,
    role:           row.role,
    active:         row.active === 1,
    approved:       row.approved === 1,
    createdAt:      row.created_at,
    updatedAt:      row.updated_at,
  };
}

function findById(id) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

function findByGitlabId(gitlabId) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE gitlab_id = ?').get(gitlabId));
}

function findByGithubId(githubId) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId));
}

function findByUsername(username) {
  return rowToUser(db.prepare('SELECT * FROM users WHERE username = ?').get(username));
}

function findAll() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(rowToUser);
}

function findPending() {
  return db.prepare('SELECT * FROM users WHERE approved = 0 ORDER BY created_at ASC').all().map(rowToUser);
}

function create({ gitlabId = null, githubId = null, username, gitlabUsername, email = null, avatarUrl = null, passwordHash = null, role = 'dev', active = 1, approved = 0 }) {
  username = username || gitlabUsername;
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, gitlab_id, github_id, username, email, avatar_url, password_hash, role, active, approved, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, gitlabId, githubId, username, email, avatarUrl, passwordHash, role, active ? 1 : 0, approved ? 1 : 0, now, now);
  return findById(id);
}

function update(id, fields) {
  if (!findById(id)) return null;
  const now = new Date().toISOString();
  const colMap = { username: 'username', email: 'email', avatarUrl: 'avatar_url', role: 'role', active: 'active', approved: 'approved', githubId: 'github_id' };
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
  return create({ gitlabId, username, email, avatarUrl, active: 0 });
}

function upsertFromGithub({ githubId, githubUsername, email, avatarUrl }) {
  let user = findByGithubId(githubId);
  if (user) {
    return update(user.id, { username: githubUsername, email, avatarUrl, githubId });
  }
  const taken = findByUsername(githubUsername);
  const username = taken ? `${githubUsername}_gh` : githubUsername;
  return create({ githubId, username, email, avatarUrl, active: 0 });
}

function remove(id) {
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
}

module.exports = { findById, findByGitlabId, findByGithubId, findByUsername, findAll, findPending, create, update, remove, upsertFromGitlab, upsertFromGithub };
