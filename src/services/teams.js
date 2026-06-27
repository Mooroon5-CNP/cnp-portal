'use strict';

const { v4: uuidv4 } = require('uuid');
const db = require('../models/db');

db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  )
`);

function _hydrate(t) {
  const members = db.prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(t.id);
  return {
    id: t.id,
    name: t.name,
    memberIds: members.map(m => m.user_id),
    createdAt: t.created_at,
  };
}

function createTeam(name) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO teams (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
  return getTeam(id);
}

function listTeams() {
  return db.prepare('SELECT * FROM teams ORDER BY created_at ASC').all().map(_hydrate);
}

function getTeam(id) {
  const t = db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  return t ? _hydrate(t) : null;
}

function addMember(teamId, userId) {
  if (!getTeam(teamId)) throw new Error('Équipe introuvable');
  try {
    db.prepare('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)').run(teamId, userId);
  } catch (_) { /* duplicate — already a member */ }
  return getTeam(teamId);
}

function removeMember(teamId, userId) {
  if (!getTeam(teamId)) throw new Error('Équipe introuvable');
  db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, userId);
  return getTeam(teamId);
}

function deleteTeam(id) {
  if (!db.prepare('SELECT id FROM teams WHERE id = ?').get(id)) throw new Error('Équipe introuvable');
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
  db.prepare('DELETE FROM teams WHERE id = ?').run(id);
}

function isMemberOf(teamId, userId) {
  return !!db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId);
}

function getTeamsForUser(userId) {
  return db.prepare(`
    SELECT t.* FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.user_id = ?
    ORDER BY t.created_at ASC
  `).all(userId).map(_hydrate);
}

// Returns a Set of all userIds that share at least one team with userId (including userId itself).
function getTeamMemberIds(userId) {
  const rows = db.prepare(`
    SELECT DISTINCT tm2.user_id FROM team_members tm1
    JOIN team_members tm2 ON tm2.team_id = tm1.team_id
    WHERE tm1.user_id = ?
  `).all(userId);
  return new Set(rows.map(r => r.user_id));
}

module.exports = { createTeam, listTeams, getTeam, addMember, removeMember, deleteTeam, isMemberOf, getTeamsForUser, getTeamMemberIds };
