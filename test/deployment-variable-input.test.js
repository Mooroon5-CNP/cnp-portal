'use strict';

const { valuesFromForm } = require('../src/services/deployment-variable-input');
const { parseDotEnv } = require('../public/js/deployment-variables');

test('imports .env names and values without executing substitutions', () => {
  expect(parseDotEnv('# comment\nexport API_KEY="value with spaces"\nEMPTY=\nURL=https://example.test # note'))
    .toEqual([{ name: 'API_KEY', value: 'value with spaces' }, { name: 'EMPTY', value: '' },
      { name: 'URL', value: 'https://example.test' }]);
  expect(() => parseDotEnv('KEY=$(cat /tmp/secret)')).toThrow('Substitution');
  expect(() => parseDotEnv('API_KEY=one\nAPI_KEY=two')).toThrow('doublon');
  expect(() => parseDotEnv('DB_PASSWORD=forbidden')).toThrow('réservée');
});

test('server accepts manual rows and rejects duplicate or forged reserved names', () => {
  expect(valuesFromForm({ variableNames: ['API_KEY', 'EMPTY'], variableValues: ['private-value', ''] }))
    .toEqual({ API_KEY: 'private-value', EMPTY: '' });
  expect(() => valuesFromForm({ variableNames: ['API_KEY', 'API_KEY'], variableValues: ['one', 'two'] }))
    .toThrow('doublon');
  expect(() => valuesFromForm({ variableNames: 'DB_PASSWORD', variableValues: 'bad' })).toThrow('réservée');
  expect(() => valuesFromForm({ variableNames: 'API_KEY', variableValues: undefined })).toThrow('manquant');
  expect(valuesFromForm({})).toEqual({});
});
