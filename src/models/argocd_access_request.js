'use strict';

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

db.exec(`
  CREATE TABLE IF NOT EXISTS argocd_access_requests (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    app_name     TEXT,
    reason       TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    argocd_username TEXT,
    argocd_password TEXT,
    reviewed_by  TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO argocd_access_requests (id, user_id, app_name, reason, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'pending', ?, ?)
`);
const getByIdStmt       = db.prepare(`SELECT * FROM argocd_access_requests WHERE id = ?`);
const listPendingStmt   = db.prepare(`SELECT * FROM argocd_access_requests WHERE status = 'pending' ORDER BY created_at ASC`);
const listForUserStmt   = db.prepare(`SELECT * FROM argocd_access_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`);
const hasPendingStmt    = db.prepare(`SELECT id FROM argocd_access_requests WHERE user_id = ? AND status = 'pending'`);
const approveStmt       = db.prepare(`
  UPDATE argocd_access_requests
  SET status = 'approved', argocd_username = ?, argocd_password = ?, reviewed_by = ?, updated_at = ?
  WHERE id = ?
`);
const rejectStmt        = db.prepare(`
  UPDATE argocd_access_requests
  SET status = 'rejected', reviewed_by = ?, updated_at = ?
  WHERE id = ?
`);

function toObj(row) {
  if (!row) return null;
  return {
    id:              row.id,
    userId:          row.user_id,
    appName:         row.app_name || null,
    reason:          row.reason,
    status:          row.status,
    argoCDUsername:  row.argocd_username || null,
    argoCDPassword:  row.argocd_password || null,
    reviewedBy:      row.reviewed_by || null,
    createdAt:       row.created_at,
    updatedAt:       row.updated_at,
  };
}

module.exports = {
  create({ userId, appName, reason }) {
    const id  = uuidv4();
    const now = new Date().toISOString();
    insertStmt.run(id, userId, appName || null, reason, now, now);
    return toObj(getByIdStmt.get(id));
  },

  hasPending(userId) {
    return !!hasPendingStmt.get(userId);
  },

  listPending() {
    return listPendingStmt.all().map(toObj);
  },

  getLatestForUser(userId) {
    return toObj(listForUserStmt.get(userId));
  },

  getById(id) {
    return toObj(getByIdStmt.get(id));
  },

  approve(id, { argoCDUsername, argoCDPassword, reviewedBy }) {
    approveStmt.run(argoCDUsername, argoCDPassword, reviewedBy, new Date().toISOString(), id);
    return toObj(getByIdStmt.get(id));
  },

  reject(id, reviewedBy) {
    rejectStmt.run(reviewedBy, new Date().toISOString(), id);
    return toObj(getByIdStmt.get(id));
  },
};
