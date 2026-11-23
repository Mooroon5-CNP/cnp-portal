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
if (!db.pragma('table_info(deployment_releases)').some(column => column.name === 'variable_generation')) {
  db.exec('ALTER TABLE deployment_releases ADD COLUMN variable_generation TEXT');
}
if (!db.pragma('table_info(deployment_releases)').some(column => column.name === 'runtime_refs_json')) {
  db.exec('ALTER TABLE deployment_releases ADD COLUMN runtime_refs_json TEXT');
}

module.exports = {
  // Production candidates waiting for a manager decision (sidebar badge).
  countAwaitingApproval() {
    return db.prepare("SELECT COUNT(*) AS c FROM deployment_releases WHERE state = 'pending'").get().c;
  },
  get(deploymentId, revision) {
    return db.prepare('SELECT * FROM deployment_releases WHERE deployment_id = ? AND revision = ?').get(deploymentId, revision);
  },
  list(deploymentId) {
    return db.prepare('SELECT * FROM deployment_releases WHERE deployment_id = ?').all(deploymentId);
  },
  resetForVariables(deploymentId, revision, generation) {
    const now = Date.now();
    const result = db.prepare(`UPDATE deployment_releases SET state = 'preparing', variable_generation = ?,
      pr_number = NULL, pr_url = NULL, head_sha = NULL, reviewed_by = NULL, reviewed_at = NULL, runtime_refs_json = NULL
      WHERE deployment_id = ? AND revision = ? AND lease_until < ? AND state IN ('published', 'rejected')`)
      .run(generation, deploymentId, revision, now);
    return result.changes === 1;
  },
  setVariableGeneration(deploymentId, revision, token, generation) {
    const result = db.prepare('UPDATE deployment_releases SET variable_generation = ? WHERE deployment_id = ? AND revision = ? AND lease_token = ? AND lease_until > ?')
      .run(generation, deploymentId, revision, token, Date.now());
    if (!result.changes) throw new Error('Le traitement du déploiement a expiré. Réessayez.');
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
      reviewed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE reviewed_at END,
      runtime_refs_json = COALESCE(?, runtime_refs_json)
      WHERE deployment_id = ? AND revision = ? AND lease_token = ? AND lease_until > ?`)
      .run(state, details.number || null, details.html_url || null, details.head_sha || null, details.reviewedBy || null,
        details.reviewedBy || null, new Date().toISOString(), details.runtimeRefs === undefined ? null : JSON.stringify(details.runtimeRefs),
        deploymentId, revision, token, Date.now());
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
