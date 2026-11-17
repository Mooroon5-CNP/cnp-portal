'use strict';

const { gcpMatches, azureMatches } = require('../src/services/openbao-observed');

test('GCP readiness requires the pinned secret version and absence of removed names', () => {
  const expected = [{ name: 'FEATURE', valueSource: { secretKeyRef: { secret: 'cnp-feature', version: '7' } } }];
  const current = [{ name: 'FEATURE', valueSource: { secretKeyRef: { secret: 'cnp-feature', version: '6' } } }];
  expect(gcpMatches(current, expected, ['FEATURE'])).toBe(false);
  current[0].valueSource.secretKeyRef.version = '7';
  expect(gcpMatches(current, expected, ['FEATURE'])).toBe(true);
  expect(gcpMatches([...current, { name: 'OLD_KEY', valueSource: { secretKeyRef: { secret: 'old', version: '1' } } }],
    expected, ['FEATURE', 'OLD_KEY'])).toBe(false);
  expect(gcpMatches([], [], ['FEATURE', 'OLD_KEY'])).toBe(true);
  expect(gcpMatches(null, [], ['FEATURE'])).toBe(false);
  expect(gcpMatches([{ name: 'FEATURE' }], [{ name: 'FEATURE' }], ['FEATURE'])).toBe(false);
});

test('Azure readiness requires the pinned Key Vault version in observed Container App secrets', () => {
  const expected = [{ name: 'FEATURE', secretName: 'cnp-feature', keyVaultSecretId: 'https://vault.test/secrets/cnp-feature/new' }];
  const observed = { env: [{ name: 'FEATURE', secretName: 'cnp-feature' }],
    secrets: [{ name: 'cnp-feature', keyVaultSecretId: 'https://vault.test/secrets/cnp-feature/old' }] };
  expect(azureMatches(observed, expected, ['FEATURE'])).toBe(false);
  observed.secrets[0].keyVaultSecretId = expected[0].keyVaultSecretId;
  expect(azureMatches(observed, expected, ['FEATURE'])).toBe(true);
  expect(azureMatches({ ...observed, env: [] }, expected, ['FEATURE'])).toBe(false);
  expect(azureMatches({ ...observed, env: [] }, [], ['FEATURE'])).toBe(true);
  expect(azureMatches(null, [], ['FEATURE'])).toBe(false);
  expect(azureMatches({ env: [{ name: 'FEATURE' }], secrets: [] }, [{ name: 'FEATURE' }], ['FEATURE'])).toBe(false);
});
