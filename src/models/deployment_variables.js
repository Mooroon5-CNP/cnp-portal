'use strict';

const db = require('./db');
require('./deployment');

db.exec(`CREATE TABLE IF NOT EXISTS deployment_variables (
  deployment_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  names_json TEXT NOT NULL,
  versions_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
)`);

const find = db.prepare('SELECT * FROM deployment_variables WHERE deployment_id = ?');
const upsert = db.prepare(`INSERT INTO deployment_variables (deployment_id, generation, names_json, versions_json, updated_at)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT(deployment_id) DO UPDATE SET generation=excluded.generation,
  names_json=excluded.names_json, versions_json=excluded.versions_json, updated_at=excluded.updated_at`);

module.exports = {
  get(deploymentId) {
    const row = find.get(deploymentId);
    return row && { generation: row.generation, names: JSON.parse(row.names_json),
      versions: JSON.parse(row.versions_json), updatedAt: row.updated_at };
  },
  save(deploymentId, { generation, names, versions }) {
    upsert.run(deploymentId, generation, JSON.stringify(names), JSON.stringify(versions), new Date().toISOString());
  },
  remove(deploymentId) {
    db.prepare('DELETE FROM deployment_variables WHERE deployment_id = ?').run(deploymentId);
  },
};
