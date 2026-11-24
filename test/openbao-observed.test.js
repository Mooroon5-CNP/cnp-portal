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

test('Azure: the observed secret has no name (sensitive in Crossplane); it is matched by its pinned Key Vault version', () => {
  // Real shape of status.atProvider on testapp09-prod (24/11/2026): no "name" in secrets, nameSecretRef in the spec.
  const version = 'https://cnp8e88553832922e781222.vault.azure.net/secrets/cnp-testapp09-prod-var-723d5e405d05/e2558e96341144eb92de8e54da42bfc3';
  const expected = [{ name: 'VARIABLE_ENV_VISIBLE', secretName: 'var-cnp-testapp09-prod-var-723d5e405d05', keyVaultSecretId: version }];
  const observed = {
    env: [{ name: 'PORT', value: '8080' }, { name: 'DB_PASSWORD', secretName: 'db-password' },
      { name: 'VARIABLE_ENV_VISIBLE', secretName: 'var-cnp-testapp09-prod-var-723d5e405d05' }],
    secrets: [{ identity: '', keyVaultSecretId: '' }, { identity: '/subscriptions/x/identities/cnp-vars', keyVaultSecretId: version }],
  };
  expect(azureMatches(observed, expected, ['VARIABLE_ENV_VISIBLE'])).toBe(true);
  // An older version still served is not a match: the release keeps waiting.
  const stale = { ...observed, secrets: [{ identity: 'x', keyVaultSecretId: version.replace(/e2558e96/, 'aaaaaaaa') }] };
  expect(azureMatches(stale, expected, ['VARIABLE_ENV_VISIBLE'])).toBe(false);
  // The variable must still reference the expected secret name.
  const rewired = { ...observed, env: [{ name: 'VARIABLE_ENV_VISIBLE', secretName: 'other' }] };
  expect(azureMatches(rewired, expected, ['VARIABLE_ENV_VISIBLE'])).toBe(false);
});
