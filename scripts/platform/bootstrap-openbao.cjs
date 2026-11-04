'use strict';
const protocol = require('../runtime/variables.cjs');
async function bootstrap(env = process.env, req = protocol.request) {
  const settings = protocol.baoSettings(env);
  if (!env.BAO_TOKEN || !/^\d{6,30}$/.test(env.CNP_OPENBAO_CONTROL_SUB || '')) throw new Error('Identité numérique de contrôle et token opérateur requis.');
  const headers = { 'X-Vault-Token': env.BAO_TOKEN };
  const call = (method, path, body) => req(`${settings.origin}/v1/${path}`, { method, headers, body });
  const health = await req(`${settings.origin}/v1/sys/health?standbyok=true`);
  if (!health.initialized || health.sealed) throw new Error('OpenBao doit être initialisé et déverrouillé.');
  const mounts = await call('GET', 'sys/mounts');
  if (mounts['cnp-runtime/']) {
    if (mounts['cnp-runtime/'].type !== 'kv' || String(mounts['cnp-runtime/'].options?.version) !== '2') throw new Error('Le mount existant ne respecte pas KV v2.');
  } else await call('POST', 'sys/mounts/cnp-runtime', { type: 'kv', options: { version: '2' } });
  await call('POST', 'cnp-runtime/config', { cas_required: true, delete_version_after: '0s' });
  const methods = await call('GET', 'sys/auth');
  if (methods['jwt/'] && methods['jwt/'].type !== 'jwt') throw new Error('Méthode JWT existante incompatible.');
  if (methods['jwt/']) {
    const previous = await call('GET', 'auth/jwt/config');
    if (previous.bound_issuer !== 'https://accounts.google.com' || previous.oidc_discovery_url !== 'https://accounts.google.com') throw new Error('Ne pas remplacer une authentification JWT existante étrangère.');
  }
  if (!methods['jwt/']) await call('POST', 'sys/auth/jwt', { type: 'jwt' });
  // Dedicated auth mount for CNP: don't run against a shared JWT mount used by other products.
  await call('POST', 'auth/jwt/config', { oidc_discovery_url: 'https://accounts.google.com', bound_issuer: 'https://accounts.google.com' });
  const policy = 'path "cnp-runtime/data/apps/*" { capabilities = ["create", "read"] }\n'
    + 'path "sys/policies/acl/cnp-*" { capabilities = ["create", "update"] }\n'
    + 'path "auth/jwt/role/cnp-*" { capabilities = ["create", "update"] }\n';
  await call('PUT', 'sys/policies/acl/cnp-control', { policy });
  await call('POST', 'auth/jwt/role/cnp-control', { role_type: 'jwt', user_claim: 'sub', bound_subject: env.CNP_OPENBAO_CONTROL_SUB,
    bound_audiences: [settings.audience], token_policies: ['cnp-control'], token_no_default_policy: true, token_ttl: '5m', token_explicit_max_ttl: '5m' });
  const audits = await call('GET', 'sys/audit');
  if (audits['cnp-file/'] && (audits['cnp-file/'].type !== 'file' || audits['cnp-file/'].options?.log_raw === 'true')) throw new Error('Audit existant incompatible.');
  if (!audits['cnp-file/']) await call('PUT', 'sys/audit/cnp-file', { type: 'file', options: { file_path: '/openbao/audit/audit.log', log_raw: 'false' } });
  return { configured: true, mount: 'cnp-runtime', role: 'cnp-control', audience: settings.audience };
}
if (require.main === module) bootstrap().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('Configuration OpenBao refusée ou incomplète. Vérifier TLS, état déverrouillé, identité opérateur et scope dédié. Aucun token affiché.'); process.exitCode = 1; });
module.exports = { bootstrap };
