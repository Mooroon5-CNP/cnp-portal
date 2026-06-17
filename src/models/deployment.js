"use strict";

const db = require('./db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

function deriveKey(secret) {
    return crypto.createHash('sha256').update(secret || '').digest();
}

const SECRET = process.env.DEPLOYMENTS_SECRET || null;

function encryptToken(plain) {
    if (!plain) return null;
    if (!SECRET) throw new Error('DEPLOYMENTS_SECRET not set in environment');
    const key = deriveKey(SECRET);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ct.toString('base64')}.${iv.toString('base64')}.${tag.toString('base64')}`;
}

function decryptToken(enc) {
    if (!enc) return null;
    if (!SECRET) throw new Error('DEPLOYMENTS_SECRET not set in environment');
    const [ct_b64, iv_b64, tag_b64] = enc.split('.');
    if (!ct_b64 || !iv_b64 || !tag_b64) return null;
    const key = deriveKey(SECRET);
    const iv = Buffer.from(iv_b64, 'base64');
    const tag = Buffer.from(tag_b64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(ct_b64, 'base64')), decipher.final()]).toString('utf8');
    return plain;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    app_name TEXT NOT NULL,
    github_repo_url TEXT NOT NULL,
    app_port INTEGER,
    config_repo_token TEXT,
    owner_user_id TEXT NOT NULL,
    owner_team_id TEXT,
    onboarding_status TEXT NOT NULL DEFAULT 'configuring',
    onboarding_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS deployment_team_access (
    deployment_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    PRIMARY KEY (deployment_id, team_id)
  )
`);

// Migrate existing tables that predate the onboarding columns.
try { db.exec(`ALTER TABLE deployments ADD COLUMN onboarding_status TEXT NOT NULL DEFAULT 'configuring'`); } catch (_) {}
try { db.exec(`ALTER TABLE deployments ADD COLUMN onboarding_error TEXT`); } catch (_) {}
try { db.exec(`ALTER TABLE deployments ADD COLUMN owner_team_id TEXT`); } catch (_) {}

const insertStmt = db.prepare(`
  INSERT INTO deployments
    (id, app_name, github_repo_url, app_port, config_repo_token, owner_user_id, owner_team_id, onboarding_status, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const listStmt = db.prepare('SELECT id, app_name, github_repo_url, app_port, owner_user_id, owner_team_id, onboarding_status, onboarding_error, created_at, updated_at FROM deployments ORDER BY created_at DESC');
const getStmt = db.prepare('SELECT * FROM deployments WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM deployments WHERE id = ?');
const updateStatusStmt = db.prepare('UPDATE deployments SET onboarding_status = ?, onboarding_error = ?, updated_at = ? WHERE id = ?');

function _rowToObj(row) {
    if (!row) return null;
    return {
        id: row.id,
        appName: row.app_name,
        githubRepoUrl: row.github_repo_url,
        appPort: row.app_port,
        configRepoToken: row.config_repo_token ? decryptToken(row.config_repo_token) : null,
        ownerUserId: row.owner_user_id,
        ownerTeamId: row.owner_team_id || null,
        onboardingStatus: row.onboarding_status || 'configuring',
        onboardingError: row.onboarding_error || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

module.exports = {
    create: ({ appName, githubRepoUrl, appPort, configRepoToken, ownerUserId, ownerTeamId = null }) => {
        const id = uuidv4();
        const now = new Date().toISOString();
        const enc = configRepoToken ? encryptToken(configRepoToken) : null;
        insertStmt.run(id, appName, githubRepoUrl, appPort || null, enc, ownerUserId, ownerTeamId || null, 'configuring', now, now);
        // Grant access to owner team automatically.
        if (ownerTeamId) {
            try { db.prepare('INSERT INTO deployment_team_access (deployment_id, team_id) VALUES (?, ?)').run(id, ownerTeamId); } catch (_) {}
        }
        return module.exports.get(id);
    },

    updateOnboardingStatus: (id, status, error = null) => {
        updateStatusStmt.run(status, error || null, new Date().toISOString(), id);
    },

    // Returns raw rows (camelCase fields only needed for list enrichment).
    listForUser: (user) => {
        const rows = listStmt.all();
        if (!user) return rows;
        if (user.role === 'manager' || user.role === 'devops') return rows;
        // dev: show deployments where user's team has access (owner or granted).
        const userTeamIds = new Set(
            db.prepare('SELECT team_id FROM team_members WHERE user_id = ?').all(user.id).map(r => r.team_id)
        );
        return rows.filter(r => {
            if (r.owner_user_id === user.id) return true;
            if (r.owner_team_id && userTeamIds.has(r.owner_team_id)) return true;
            // check granted access
            const granted = db.prepare('SELECT team_id FROM deployment_team_access WHERE deployment_id = ?').all(r.id);
            return granted.some(g => userTeamIds.has(g.team_id));
        });
    },

    get: (id) => _rowToObj(getStmt.get(id)),

    // Team access management.
    getAccessibleTeamIds: (deploymentId) => {
        return db.prepare('SELECT team_id FROM deployment_team_access WHERE deployment_id = ?')
            .all(deploymentId).map(r => r.team_id);
    },

    grantTeamAccess: (deploymentId, teamId) => {
        try { db.prepare('INSERT INTO deployment_team_access (deployment_id, team_id) VALUES (?, ?)').run(deploymentId, teamId); } catch (_) {}
    },

    revokeTeamAccess: (deploymentId, teamId) => {
        db.prepare('DELETE FROM deployment_team_access WHERE deployment_id = ? AND team_id = ?').run(deploymentId, teamId);
    },

    delete: (id) => {
        db.prepare('DELETE FROM deployment_team_access WHERE deployment_id = ?').run(id);
        deleteStmt.run(id);
    },
};
