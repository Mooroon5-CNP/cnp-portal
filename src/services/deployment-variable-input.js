'use strict';

const { validate } = require('./openbao-variables');

function valuesFromForm(body) {
  const rawNames = body.variableNames;
  const rawValues = body.variableValues;
  if (rawNames === undefined && rawValues === undefined) return {};
  const names = Array.isArray(rawNames) ? rawNames : [rawNames];
  const values = Array.isArray(rawValues) ? rawValues : [rawValues];
  if (names.length !== values.length || names.length > 50 || names.length === 0) {
    throw new Error('Lignes de variables invalides (maximum 50).');
  }
  const selected = Object.create(null);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const value = values[i];
    if (typeof name !== 'string' || typeof value !== 'string' || !name || Object.hasOwn(selected, name)) {
      throw new Error('Nom de variable manquant ou en doublon.');
    }
    selected[name] = value;
  }
  validate(selected);
  return selected;
}

module.exports = { valuesFromForm };
