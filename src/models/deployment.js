"use strict";

const db = require('./db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// DEPLOYMENTS_SECRET must be provided in env to encrypt stored tokens.
// It's hashed to derive a 32-byte key.
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const insertStmt = db.prepare('INSERT INTO deployments (id, app_name, github_repo_url, app_port, config_repo_token, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const listStmt = db.prepare('SELECT id, app_name, github_repo_url, app_port, config_repo_token, owner_user_id, created_at, updated_at FROM deployments ORDER BY created_at DESC');
const getStmt = db.prepare('SELECT * FROM deployments WHERE id = ?');
const deleteStmt = db.prepare('DELETE FROM deployments WHERE id = ?');

module.exports = {
    create: ({ appName, githubRepoUrl, appPort, configRepoToken, ownerUserId }) => {
        const id = uuidv4();
        const now = new Date().toISOString();
        const enc = configRepoToken ? encryptToken(configRepoToken) : null;
        insertStmt.run(id, appName, githubRepoUrl, appPort || null, enc, ownerUserId, now, now);
        return module.exports.get(id);
    },
    listForUser: (user) => {
        const rows = listStmt.all();
        if (!user) return rows.map(r => ({ ...r }));
        // If user is manager or devops, show all
        if (user.role === 'manager' || user.role === 'devops') return rows.map(r => ({ ...r }));
        // otherwise only those owned by this user
        return rows.filter(r => r.owner_user_id === user.id).map(r => ({ ...r }));
    },
    get: (id) => {
        const row = getStmt.get(id);
        if (!row) return null;
        return {
            id: row.id,
            appName: row.app_name,
            githubRepoUrl: row.github_repo_url,
            appPort: row.app_port,
            configRepoTokenEncrypted: row.config_repo_token,
            configRepoToken: row.config_repo_token ? decryptToken(row.config_repo_token) : null,
            ownerUserId: row.owner_user_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    },
    delete: (id) => {
        deleteStmt.run(id);
    }
};
