'use strict';

// Provider status must show the pinned secret versions before a variable-only
// promotion can be called ready: the image SHA is unchanged in that case.
function list(value) { return Array.isArray(value) ? value : null; }

function gcpMatches(observed, expected, ownedNames) {
  const env = list(observed);
  if (!env || !Array.isArray(expected) || !Array.isArray(ownedNames)) return false;
  if (!expected.every(item => typeof item?.name === 'string' && item.name.length > 0
    && typeof item.valueSource?.secretKeyRef?.secret === 'string' && item.valueSource.secretKeyRef.secret.length > 0
    && typeof item.valueSource.secretKeyRef.version === 'string' && item.valueSource.secretKeyRef.version.length > 0)) return false;
  const current = new Map(env.filter(item => item && typeof item.name === 'string').map(item => [item.name, item]));
  const wanted = new Map(expected.map(item => [item.name, item]));
  if (expected.length !== wanted.size) return false;
  for (const name of ownedNames) {
    if (current.has(name) !== wanted.has(name)) return false;
  }
  return expected.every(item => {
    const actual = current.get(item.name)?.valueSource?.secretKeyRef;
    const pin = item.valueSource?.secretKeyRef;
    return actual?.secret === pin?.secret && actual?.version === pin?.version;
  });
}

function azureMatches(observed, expected, ownedNames) {
  const env = list(observed?.env), secrets = list(observed?.secrets);
  if (!env || !secrets || !Array.isArray(expected) || !Array.isArray(ownedNames)) return false;
  if (!expected.every(item => typeof item?.name === 'string' && item.name.length > 0
    && typeof item.secretName === 'string' && item.secretName.length > 0
    && typeof item.keyVaultSecretId === 'string' && item.keyVaultSecretId.length > 0)) return false;
  const current = new Map(env.filter(item => item && typeof item.name === 'string').map(item => [item.name, item]));
  const secretByName = new Map(secrets.filter(item => item && typeof item.name === 'string').map(item => [item.name, item]));
  const wanted = new Map(expected.map(item => [item.name, item]));
  if (expected.length !== wanted.size) return false;
  for (const name of ownedNames) {
    if (current.has(name) !== wanted.has(name)) return false;
  }
  return expected.every(item => {
    const actual = current.get(item.name);
    const secret = secretByName.get(item.secretName);
    return actual?.secretName === item.secretName && secret?.keyVaultSecretId === item.keyVaultSecretId;
  });
}

module.exports = { gcpMatches, azureMatches };
