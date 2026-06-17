'use strict';

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

db.exec(`
  CREATE TABLE IF NOT EXISTS deletion_requests (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO deletion_requests (id, deployment_id, requested_by, reason, status, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'pending', ?, ?)
`);
const listPendingStmt = db.prepare(`SELECT * FROM deletion_requests WHERE status = 'pending' ORDER BY created_at DESC`);
const listForDeploymentStmt = db.prepare(`SELECT * FROM deletion_requests WHERE deployment_id = ? ORDER BY created_at DESC`);
const getStmt = db.prepare(`SELECT * FROM deletion_requests WHERE id = ?`);
const updateStatusStmt = db.prepare(`UPDATE deletion_requests SET status = ?, reviewed_by = ?, updated_at = ? WHERE id = ?`);
const deleteByDeploymentStmt = db.prepare(`DELETE FROM deletion_requests WHERE deployment_id = ?`);

function toObj(row) {
    if (!row) return null;
    return {
        id: row.id,
        deploymentId: row.deployment_id,
        requestedBy: row.requested_by,
        reason: row.reason || null,
        status: row.status,
        reviewedBy: row.reviewed_by || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = {
    create: ({ deploymentId, requestedBy, reason }) => {
        const id = uuidv4();
        const now = new Date().toISOString();
        insertStmt.run(id, deploymentId, requestedBy, reason || null, now, now);
        return toObj(getStmt.get(id));
    },
    listPending: () => listPendingStmt.all().map(toObj),
    listForDeployment: (deploymentId) => listForDeploymentStmt.all(deploymentId).map(toObj),
    get: (id) => toObj(getStmt.get(id)),
    approve: (id, reviewedBy) => {
        updateStatusStmt.run('approved', reviewedBy, new Date().toISOString(), id);
    },
    reject: (id, reviewedBy) => {
        updateStatusStmt.run('rejected', reviewedBy, new Date().toISOString(), id);
    },
    deleteByDeployment: (deploymentId) => {
        deleteByDeploymentStmt.run(deploymentId);
    },
};
