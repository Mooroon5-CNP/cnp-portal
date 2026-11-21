'use strict';

const { valuesFromForm } = require('../src/services/deployment-variable-input');
const { parseDotEnv, encodeBase64 } = require('../public/js/deployment-variables');

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

test('une valeur multiligne importée d\'un .env arrive intacte, retours à la ligne compris', () => {
  const pem = '-----BEGIN KEY-----\nabc\ndéf\n-----END KEY-----';
  const [row] = parseDotEnv(`PRIVATE_KEY="${pem.replace(/\n/g, '\\n')}"`);
  expect(row.value).toBe(pem);
  expect(valuesFromForm({ variableNames: ['PRIVATE_KEY', 'API_KEY'], variableValues: [encodeBase64(row.value), 'simple'],
    variableEncodings: ['base64', 'plain'] })).toEqual({ PRIVATE_KEY: pem, API_KEY: 'simple' });
});

test('un encodage inconnu, un base64 invalide ou des lignes incohérentes sont refusés', () => {
  expect(() => valuesFromForm({ variableNames: 'A', variableValues: 'x', variableEncodings: 'hex' })).toThrow('mal encodée');
  expect(() => valuesFromForm({ variableNames: 'A', variableValues: 'pas du base64 !', variableEncodings: 'base64' })).toThrow('mal encodée');
  expect(() => valuesFromForm({ variableNames: 'A', variableValues: '/w==', variableEncodings: 'base64' })).toThrow('mal encodée');
  expect(() => valuesFromForm({ variableNames: ['A', 'B'], variableValues: ['x', 'y'], variableEncodings: ['plain'] })).toThrow('invalides');
});
