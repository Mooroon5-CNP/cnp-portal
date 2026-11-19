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
for (const [column, definition] of [['owned_names_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['history_json', "TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!db.pragma('table_info(deployment_variables)').some(item => item.name === column)) {
    db.exec(`ALTER TABLE deployment_variables ADD COLUMN ${column} ${definition}`);
  }
}

const find = db.prepare('SELECT * FROM deployment_variables WHERE deployment_id = ?');
const upsert = db.prepare(`INSERT INTO deployment_variables (deployment_id, generation, names_json, versions_json, updated_at, owned_names_json, history_json)
  VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(deployment_id) DO UPDATE SET generation=excluded.generation,
  names_json=excluded.names_json, versions_json=excluded.versions_json, updated_at=excluded.updated_at,
  owned_names_json=excluded.owned_names_json, history_json=excluded.history_json`);

module.exports = {
  get(deploymentId) {
    const row = find.get(deploymentId);
    if (!row) return null;
    const names = JSON.parse(row.names_json), versions = JSON.parse(row.versions_json);
    const history = JSON.parse(row.history_json);
    if (!history.some(entry => entry.generation === row.generation)) history.push({ generation: row.generation, names, versions });
    return { generation: row.generation, names, versions, updatedAt: row.updated_at,
      ownedNames: [...new Set([...JSON.parse(row.owned_names_json), ...names])], history };
  },
  save(deploymentId, { generation, names, versions }) {
    const previous = this.get(deploymentId);
    const ownedNames = [...new Set([...(previous?.ownedNames || []), ...names])];
    const history = [...(previous?.history || []), { generation, names, versions }];
    upsert.run(deploymentId, generation, JSON.stringify(names), JSON.stringify(versions), new Date().toISOString(),
      JSON.stringify(ownedNames), JSON.stringify(history));
  },
  remove(deploymentId) {
    db.prepare('DELETE FROM deployment_variables WHERE deployment_id = ?').run(deploymentId);
  },
};
