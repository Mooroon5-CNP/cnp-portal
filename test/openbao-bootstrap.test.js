'use strict';
const { bootstrap } = require('../scripts/platform/bootstrap-openbao.cjs');
const env = { CNP_OPENBAO_ADDR: 'https://bao.test', BAO_TOKEN: 'test-only-bootstrap-token', CNP_OPENBAO_CONTROL_SUB: '123456789012345678901' };
test('configures a dedicated versioned mount, bound identity and audit without returning token', async () => {
  const calls = [];
  const req = async (url, args) => { calls.push([url, args]); return url.includes('sys/health') ? { initialized: true, sealed: false } : {}; };
  const result = await bootstrap(env, req);
  expect(JSON.stringify(result)).not.toContain(env.BAO_TOKEN);
  const role = calls.find(([url]) => url.endsWith('auth/jwt/role/cnp-control'))[1].body;
  expect(role.bound_subject).toBe(env.CNP_OPENBAO_CONTROL_SUB); expect(role.bound_audiences).toEqual(['https://bao.test']);
  expect(role.token_no_default_policy).toBe(true);
  expect(calls.find(([url]) => url.endsWith('cnp-runtime/config'))[1].body.cas_required).toBe(true);
  expect(calls.find(([url]) => url.endsWith('sys/audit/cnp-file'))[1].body.options.log_raw).toBe('false');
});
test('refuses sealed service or an incompatible preexisting mount before writing policy', async () => {
  await expect(bootstrap(env, async () => ({ initialized: true, sealed: true }))).rejects.toThrow('déverrouillé');
  await expect(bootstrap(env, async url => url.includes('health') ? { initialized: true, sealed: false } : { 'cnp-runtime/': { type: 'kv', options: { version: '1' } } })).rejects.toThrow('KV v2');
});
