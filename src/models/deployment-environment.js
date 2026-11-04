'use strict';
const db = require('./db');
const { randomUUID } = require('crypto');
db.exec(`CREATE TABLE IF NOT EXISTS deployment_environment_refs (
  deployment_id TEXT PRIMARY KEY, refs_json TEXT NOT NULL, updated_at TEXT NOT NULL
)`);
for (const [name, declaration] of [['runtime_account', 'TEXT'], ['bundle_json', 'TEXT'], ['removed_json', "TEXT NOT NULL DEFAULT '[]'"]]) {
  if (!db.pragma('table_info(deployment_environment_refs)').some(column => column.name === name)) db.exec(`ALTER TABLE deployment_environment_refs ADD COLUMN ${name} ${declaration}`);
}
db.exec(`CREATE TABLE IF NOT EXISTS deployment_configuration_locks (
  deployment_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL
)`);
function acquire(id) {
  const token = randomUUID(); const now = Date.now();
  const result = db.prepare(`INSERT INTO deployment_configuration_locks VALUES (?, ?, ?)
    ON CONFLICT(deployment_id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
    WHERE deployment_configuration_locks.expires_at < ?`).run(id, token, now + 600000, now);
  if (!result.changes) throw new Error('Une modification des variables est déjà en cours.');
  return token;
}
function renew(id, token) {
  const now = Date.now();
  const result = db.prepare('UPDATE deployment_configuration_locks SET expires_at=? WHERE deployment_id=? AND token=? AND expires_at>?')
    .run(now + 600000, id, token, now);
  if (!result.changes) throw new Error('La modification des variables a expiré. Réessayez.');
}
function release(id, token) { db.prepare('DELETE FROM deployment_configuration_locks WHERE deployment_id=? AND token=?').run(id, token); }
function busy(id) { return !!db.prepare('SELECT 1 FROM deployment_configuration_locks WHERE deployment_id=? AND expires_at>?').get(id, Date.now()); }
function metadata(id) {
  const row = db.prepare('SELECT runtime_account, removed_json FROM deployment_environment_refs WHERE deployment_id=?').get(id);
  const removed = row ? JSON.parse(row.removed_json) : [];
  if (!Array.isArray(removed) || removed.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new Error('Métadonnées applicatives invalides.');
  return { account: row?.runtime_account || null, removed };
}
function save(id, refs, { account = null, removed = [], bundle = null } = {}) {
  if (bundle) validateBundle(bundle);
  db.prepare(`INSERT INTO deployment_environment_refs (deployment_id, refs_json, updated_at, runtime_account, removed_json, bundle_json) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(deployment_id) DO UPDATE SET refs_json=excluded.refs_json, updated_at=excluded.updated_at,
      runtime_account=excluded.runtime_account, removed_json=excluded.removed_json, bundle_json=excluded.bundle_json`)
    .run(id, JSON.stringify(refs), new Date().toISOString(), account, JSON.stringify(removed), bundle ? JSON.stringify(bundle) : null);
}
function get(id) {
  const row = db.prepare('SELECT refs_json FROM deployment_environment_refs WHERE deployment_id = ?').get(id);
  let refs;
  try { refs = row ? JSON.parse(row.refs_json) : []; }
  catch (_) { throw new Error('Références applicatives existantes illisibles.'); }
  if (!Array.isArray(refs) || refs.some(ref => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref?.name || '')) return true;
    if (ref.value === '' && Object.keys(ref).every(key => ['name', 'value'].includes(key))) return false;
    return !/^[A-Za-z0-9_-]+$/.test(ref?.valueSource?.secretKeyRef?.secret || '')
      || !/^\d+$/.test(ref?.valueSource?.secretKeyRef?.version || '')
      || Object.keys(ref).some(key => !['name', 'valueSource'].includes(key));
  })) throw new Error('Références applicatives existantes invalides.');
  return refs;
}
function validateBundle(value) {
  require('../../scripts/runtime/variables.cjs').reference(value.reference);
  if (!Array.isArray(value.names) || value.names.length > 100 || value.names.some(name => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) throw new Error('Métadonnées du bundle invalides.');
  return value;
}
function bundle(id) {
  const row = db.prepare('SELECT bundle_json FROM deployment_environment_refs WHERE deployment_id=?').get(id);
  return row?.bundle_json ? validateBundle(JSON.parse(row.bundle_json)) : null;
}
function remove(id) { db.prepare('DELETE FROM deployment_environment_refs WHERE deployment_id = ?').run(id); }
module.exports = { bundle, get, remove, save, metadata, acquire, renew, release, busy };
