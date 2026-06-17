'use strict';

const { v4: uuidv4 } = require('uuid');

// In-memory store — data is lost on restart (consistent with other portal stores)
const teams = [];

function createTeam(name) {
  const team = { id: uuidv4(), name, memberIds: new Set(), createdAt: new Date().toISOString() };
  teams.push(team);
  return _serialize(team);
}

function listTeams() {
  return teams.map(_serialize);
}

function getTeam(id) {
  const t = teams.find(t => t.id === id);
  return t ? _serialize(t) : null;
}

function addMember(teamId, userId) {
  const team = _raw(teamId);
  if (!team) throw new Error('Équipe introuvable');
  team.memberIds.add(userId);
  return _serialize(team);
}

function removeMember(teamId, userId) {
  const team = _raw(teamId);
  if (!team) throw new Error('Équipe introuvable');
  team.memberIds.delete(userId);
  return _serialize(team);
}

function deleteTeam(id) {
  const idx = teams.findIndex(t => t.id === id);
  if (idx === -1) throw new Error('Équipe introuvable');
  teams.splice(idx, 1);
}

function isMemberOf(teamId, userId) {
  const team = _raw(teamId);
  return team ? team.memberIds.has(userId) : false;
}

function getTeamsForUser(userId) {
  return teams.filter(t => t.memberIds.has(userId)).map(_serialize);
}

// Returns a Set of all userIds that share at least one team with userId (including userId itself)
function getTeamMemberIds(userId) {
  const result = new Set();
  for (const team of teams) {
    if (team.memberIds.has(userId)) {
      for (const id of team.memberIds) result.add(id);
    }
  }
  return result;
}

function _raw(id) {
  return teams.find(t => t.id === id) || null;
}

function _serialize(team) {
  return { id: team.id, name: team.name, memberIds: [...team.memberIds], createdAt: team.createdAt };
}

module.exports = { createTeam, listTeams, getTeam, addMember, removeMember, deleteTeam, isMemberOf, getTeamsForUser, getTeamMemberIds };
