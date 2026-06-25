'use strict';

const db = require('./db');
const { v4: uuidv4 } = require('uuid');

db.exec(`
  CREATE TABLE IF NOT EXISTS manifest_mrs (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    app_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    commit_message TEXT,
    requested_by TEXT NOT NULL,
    reviewed_by TEXT,
    review_comment TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

function _row(r) {
    if (!r) return null;
    return {
        id: r.id,
        deploymentId: r.deployment_id,
        appName: r.app_name,
        filePath: r.file_path,
        branchName: r.branch_name,
        prNumber: r.pr_number,
        prUrl: r.pr_url,
        status: r.status,
        commitMessage: r.commit_message,
        requestedBy: r.requested_by,
        reviewedBy: r.reviewed_by,
        reviewComment: r.review_comment,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

module.exports = {
    create({ deploymentId, appName, filePath, branchName, prNumber, prUrl, commitMessage, requestedBy }) {
        const id = uuidv4();
        const now = new Date().toISOString();
        db.prepare(`
            INSERT INTO manifest_mrs
              (id, deployment_id, app_name, file_path, branch_name, pr_number, pr_url, status, commit_message, requested_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
        `).run(id, deploymentId, appName, filePath, branchName, prNumber || null, prUrl || null, commitMessage || null, requestedBy, now, now);
        return module.exports.get(id);
    },

    get(id) {
        return _row(db.prepare('SELECT * FROM manifest_mrs WHERE id = ?').get(id));
    },

    // All MRs submitted by a user.
    listForUser(userId) {
        return db.prepare('SELECT * FROM manifest_mrs WHERE requested_by = ? ORDER BY created_at DESC').all(userId).map(_row);
    },

    // Pending/rejected MRs for a set of deployment IDs (manager scope).
    listForDeployments(deploymentIds) {
        if (!deploymentIds.length) return [];
        const placeholders = deploymentIds.map(() => '?').join(',');
        return db.prepare(
            `SELECT * FROM manifest_mrs WHERE deployment_id IN (${placeholders}) ORDER BY created_at DESC`
        ).all(...deploymentIds).map(_row);
    },

    // Pending MRs for a specific deployment (used on the detail page).
    listPendingForDeployment(deploymentId) {
        return db.prepare(
            "SELECT * FROM manifest_mrs WHERE deployment_id = ? AND status = 'pending' ORDER BY created_at DESC"
        ).all(deploymentId).map(_row);
    },

    // Update PR info after creation (pr_number + pr_url).
    setPrInfo(id, prNumber, prUrl) {
        db.prepare('UPDATE manifest_mrs SET pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?')
            .run(prNumber, prUrl, new Date().toISOString(), id);
    },

    approve(id, reviewedBy) {
        db.prepare("UPDATE manifest_mrs SET status = 'approved', reviewed_by = ?, review_comment = NULL, updated_at = ? WHERE id = ?")
            .run(reviewedBy, new Date().toISOString(), id);
    },

    reject(id, reviewedBy, comment) {
        db.prepare("UPDATE manifest_mrs SET status = 'rejected', reviewed_by = ?, review_comment = ?, updated_at = ? WHERE id = ?")
            .run(reviewedBy, comment || null, new Date().toISOString(), id);
    },

    // Mark as pending again (resubmission after rejection).
    resubmit(id) {
        db.prepare("UPDATE manifest_mrs SET status = 'pending', reviewed_by = NULL, review_comment = NULL, updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), id);
    },

    delete(id) {
        db.prepare('DELETE FROM manifest_mrs WHERE id = ?').run(id);
    },

    // Count of all pending MRs (for manager notification badge).
    countAllPending() {
        return db.prepare("SELECT COUNT(*) AS c FROM manifest_mrs WHERE status = 'pending'").get().c;
    },

    // Count of rejected MRs for a specific devops (badge prompting resubmission).
    countRejectedForUser(userId) {
        return db.prepare("SELECT COUNT(*) AS c FROM manifest_mrs WHERE requested_by = ? AND status = 'rejected'").get(userId).c;
    },

    // Returns all pending MRs across the platform (used for sync).
    listAllPending() {
        return db.prepare("SELECT * FROM manifest_mrs WHERE status = 'pending'").all().map(_row);
    },
};
