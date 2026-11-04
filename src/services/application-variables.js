'use strict';
const storage = require('../models/deployment-environment');
const provider = require('../clients/secret-manager');
const bundles = require('../clients/variable-bundles');
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = /^(PORT|HOST|DATA_DIR|DD_ENV|DD_SERVICE|DD_VERSION|LOG_LEVEL|CNP_VARIABLES_.*|CNP_OPENBAO_.*)$/;
function parse(body) {
  const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
  const names = array(body.variableName); const values = array(body.variableValue); const actions = array(body.variableAction);
  if (names.length > 100 || names.length !== values.length || names.length !== actions.length) throw new Error('Liste de variables invalide (100 maximum).');
  const seen = new Set(); let size = 0;
  return names.map((name, index) => {
    const value = values[index]; const action = actions[index];
    if (typeof name !== 'string' || !KEY.test(name) || name.length > 128) throw new Error('Nom de variable invalide : lettres, chiffres et underscore.');
    if (RESERVED.test(name)) throw new Error(`${name} est gérée automatiquement par la plateforme.`);
    if (seen.has(name)) throw new Error('Les noms de variables doivent être uniques.'); seen.add(name);
    if (!['set', 'keep', 'remove'].includes(action) || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 32768) throw new Error('Valeur ou action invalide (32 Kio par valeur).');
    if (action !== 'set' && value !== '') throw new Error('Les valeurs ne sont acceptées que pour un ajout ou remplacement.');
    size += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (size > 65536) throw new Error('Les variables dépassent 64 Kio.');
    return { name, value, action };
  });
}
function assertTarget(dep) {
  if (dep.targetCluster !== 'gcp' || !['dev', 'prod'].includes(dep.environment) || dep.unsupportedRuntime) throw new Error('Variables disponibles pour Cloud Run GCP.');
}
async function check() { return bundles.provider() === 'secret-manager' ? provider.capability() : bundles.capability(); }
async function assertReady() {
  const result = await check();
  if (!result.available) throw new Error(result.message);
}
async function prepare(dep, changes, renew = () => {}) {
  assertTarget(dep);
  const deadline = Date.now() + 120000;
  const checkBudget = () => { if (Date.now() > deadline) throw new Error('Préparation des variables trop longue. Aucune nouvelle configuration publiée.'); renew(); };
  const previousBundle = storage.bundle(dep.id);
  if (bundles.provider() !== 'secret-manager' || previousBundle) {
    if (storage.get(dep.id).length) throw new Error('Les références historiques nécessitent une migration opérateur explicite.');
    const values = previousBundle ? await bundles.read(previousBundle) : Object.create(null);
    for (const change of changes) {
      if (change.action === 'keep' && !Object.hasOwn(values, change.name)) throw new Error('Variable existante introuvable.');
      if (change.action === 'remove') delete values[change.name];
      if (change.action === 'set') Object.defineProperty(values, change.name, { value: change.value, enumerable: true, writable: true, configurable: true });
    }
    require('../../scripts/runtime/variables.cjs').validateValues(values);
    checkBudget(); await assertReady(); await bundles.prepare(dep);
    const bundle = await bundles.write(dep, values);
    const meta = storage.metadata(dep.id); checkBudget();
    return { refs: [], account: bundles.runtimeAccount(dep), removed: meta.removed, bundle };
  }
  const current = storage.get(dep.id); const meta = storage.metadata(dep.id);
  const updates = changes.filter(change => change.action === 'set');
  const deleted = new Set(changes.filter(change => change.action === 'remove').map(change => change.name));
  for (const change of changes) if (change.action === 'keep' && !current.some(ref => ref.name === change.name)) throw new Error('Variable existante introuvable.');
  if (current.filter(ref => !deleted.has(ref.name) && !updates.some(change => change.name === ref.name)).length + updates.length > 100) throw new Error('Maximum de 100 variables par environnement.');
  if (updates.length) { checkBudget(); await assertReady(); await provider.prepare(dep); }
  const next = [];
  // Limit parallel writes, and wait for every result before deciding on metadata.
  for (let start = 0; start < updates.length; start += 4) {
    checkBudget();
    const results = await Promise.allSettled(updates.slice(start, start + 4).map(change => provider.store(dep, change.name, change.value)));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw new Error('Enregistrement sécurisé impossible. Aucune nouvelle configuration n’a été publiée.');
    next.push(...results.map(result => result.value));
  }
  const refs = current.filter(ref => !deleted.has(ref.name) && !updates.some(change => change.name === ref.name)).concat(next);
  if (refs.length > 100) throw new Error('Maximum de 100 variables par application et environnement.');
  const removed = [...new Set([...meta.removed, ...deleted])].filter(name => !refs.some(ref => ref.name === name));
  checkBudget();
  return { refs, account: updates.length ? provider.runtimeAccount(dep) : meta.account, removed };
}
async function update(dep, changes, publish) {
  const token = storage.acquire(dep.id);
  try {
    const previous = { refs: storage.get(dep.id), bundle: storage.bundle(dep.id), ...storage.metadata(dep.id) };
    const renew = () => storage.renew(dep.id, token);
    const next = await prepare(dep, changes, renew);
    storage.save(dep.id, next.refs, next);
    try { await publish(renew); }
    catch (error) { renew(); storage.save(dep.id, previous.refs, previous); throw error; }
  } finally { storage.release(dep.id, token); }
}
function transportAllowed(req) {
  return req.secure || (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname));
}
module.exports = { parse, prepare, update, check, assertReady, transportAllowed, names: id => storage.bundle(id)?.names || storage.get(id).map(ref => ref.name) };
