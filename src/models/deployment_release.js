'use strict';

const db = require('./db');
const { randomUUID } = require('crypto');

db.exec(`CREATE TABLE IF NOT EXISTS deployment_releases (
  deployment_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'preparing',
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (deployment_id, revision)
)`);

module.exports = {
  get(deploymentId, revision) {
    return db.prepare('SELECT * FROM deployment_releases WHERE deployment_id = ? AND revision = ?').get(deploymentId, revision);
  },
  list(deploymentId) {
    return db.prepare('SELECT * FROM deployment_releases WHERE deployment_id = ?').all(deploymentId);
  },
  acquire(deploymentId, revision, runId) {
    db.prepare('INSERT OR IGNORE INTO deployment_releases (deployment_id, revision, run_id) VALUES (?, ?, ?)').run(deploymentId, revision, runId);
    const now = Date.now();
    const token = randomUUID();
    const result = db.prepare('UPDATE deployment_releases SET lease_token = ?, lease_until = ? WHERE deployment_id = ? AND revision = ? AND lease_until < ?')
      .run(token, now + 300000, deploymentId, revision, now);
    return result.changes === 1 ? token : null;
  },
  save(deploymentId, revision, token, state, details = {}) {
    const result = db.prepare(`UPDATE deployment_releases SET state = ?, pr_number = COALESCE(?, pr_number),
      pr_url = COALESCE(?, pr_url), head_sha = COALESCE(?, head_sha), reviewed_by = COALESCE(?, reviewed_by),
      reviewed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE reviewed_at END
      WHERE deployment_id = ? AND revision = ? AND lease_token = ? AND lease_until > ?`)
      .run(state, details.number || null, details.html_url || null, details.head_sha || null, details.reviewedBy || null,
        details.reviewedBy || null, new Date().toISOString(), deploymentId, revision, token, Date.now());
    if (!result.changes) throw new Error('Le traitement du déploiement a expiré. Réessayez.');
  },
  owns(deploymentId, revision, token) {
    return Boolean(db.prepare('SELECT 1 FROM deployment_releases WHERE deployment_id = ? AND revision = ? AND lease_token = ? AND lease_until > ?')
      .get(deploymentId, revision, token, Date.now()));
  },
  release(deploymentId, revision, token) {
    db.prepare('UPDATE deployment_releases SET lease_token = NULL, lease_until = 0 WHERE deployment_id = ? AND revision = ? AND lease_token = ?')
      .run(deploymentId, revision, token);
  },
};
