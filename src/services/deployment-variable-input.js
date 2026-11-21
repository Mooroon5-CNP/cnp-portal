'use strict';

const { validate } = require('./openbao-variables');

function decode(value, encoding) {
  if (encoding === 'plain') return value;
  if (encoding !== 'base64' || typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Valeur de variable mal encodée.');
  }
  const bytes = Buffer.from(value, 'base64');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (_) { throw new Error('Valeur de variable mal encodée.'); }
}

function valuesFromForm(body) {
  const rawNames = body.variableNames;
  const rawValues = body.variableValues;
  if (rawNames === undefined && rawValues === undefined) return {};
  const names = Array.isArray(rawNames) ? rawNames : [rawNames];
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  // Encodage par ligne (public/js/deployment-variables.js) : « base64 » pour une valeur multiligne importée d'un .env, que
  // le formulaire ne peut pas transmettre telle quelle. Absent (ancien formulaire, appel direct) : toutes les valeurs en clair.
  const rawEncodings = body.variableEncodings;
  const encodings = rawEncodings === undefined ? names.map(() => 'plain') : Array.isArray(rawEncodings) ? rawEncodings : [rawEncodings];
  if (names.length !== values.length || names.length !== encodings.length || names.length > 50 || names.length === 0) {
    throw new Error('Lignes de variables invalides (maximum 50).');
  }
  const selected = Object.create(null);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const value = decode(values[i], encodings[i]);
    if (typeof name !== 'string' || typeof value !== 'string' || !name || Object.hasOwn(selected, name)) {
      throw new Error('Nom de variable manquant ou en doublon.');
    }
    selected[name] = value;
  }
  validate(selected);
  return selected;
}

module.exports = { valuesFromForm };
