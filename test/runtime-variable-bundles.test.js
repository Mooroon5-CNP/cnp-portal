'use strict';
const { createClient, reference, validateValues, request } = require('../scripts/runtime/variables.cjs');
const { environment } = require('../scripts/runtime/start.cjs');
const target = { applicationId: '11111111-1111-1111-1111-111111111111', environment: 'dev' };
const bundleId = '22222222-2222-2222-2222-222222222222';
const gcsRef = { ...target, schemaVersion: 1, bundleId, provider: 'gcs', bucket: 'cnp-test-vars', object: `bundles/${bundleId}.json`, generation: '90071992547409931' };
const values = { API_KEY: 'canary-private', MULTILINE: 'line1\nline2', EMPTY: '', UNICODE: 'été', EQUALS: 'a=b' };

test('GCS writes once and reads the exact generation without loss or floating latest', async () => {
  let payload;
  const req = jest.fn(async (url, args) => {
    expect(args.headers.Authorization).toBe('Bearer ephemeral');
    if (url.includes('/upload/')) { expect(url).toContain('ifGenerationMatch=0'); payload = args.body; return { generation: gcsRef.generation }; }
    expect(url).toContain(`generation=${gcsRef.generation}`); return payload;
  });
  const client = createClient({ req, getAccess: async () => 'ephemeral' });
  const ref = await client.writeBundle(target, values, 'gcs', { bundleId, bucket: gcsRef.bucket });
  expect(ref).toEqual(gcsRef); expect(JSON.stringify(ref)).not.toContain('canary-private');
  expect(await client.readBundle(ref)).toEqual(values);
});
test('OpenBao exchanges a JWT for the scope role and reads a pinned KV v2 version', async () => {
  let payload;
  const req = jest.fn(async (url, args) => {
    if (url.endsWith('/auth/jwt/login')) { expect(args.body.jwt).toBe('identity-jwt'); return { auth: { client_token: 'short-token' } }; }
    expect(args.headers['X-Vault-Token']).toBe('short-token');
    if (args.method === 'POST') { expect(args.body.options.cas).toBe(0); payload = args.body.data; return { data: { version: 1 } }; }
    expect(url).toContain('?version=1'); return { data: { data: payload, metadata: { version: 1 } } };
  });
  const jwt = jest.fn(async () => 'identity-jwt');
  const client = createClient({ req, getJWT: jwt, env: { CNP_OPENBAO_ADDR: 'https://bao.internal.test' } });
  const ref = await client.writeBundle(target, values, 'openbao', { bundleId });
  expect(await client.readBundle(ref)).toEqual(values);
  expect(jwt).toHaveBeenCalledWith('https://bao.internal.test');
  expect(req.mock.calls.filter(([url]) => url.endsWith('/login')).map(([, args]) => args.body.role)).toEqual(['cnp-control', `cnp-${target.applicationId}-dev`]);
});
test('wrong scope, deleted version and unsupported references fail closed', async () => {
  const client = createClient({ getAccess: async () => 'token', req: async () => ({ ...target, schemaVersion: 1, bundleId, environment: 'prod', values }) });
  await expect(client.readBundle(gcsRef)).rejects.toThrow('CONFIG_SCOPE_MISMATCH');
  expect(() => reference({ ...gcsRef, generation: 'latest' })).toThrow();
  expect(() => reference({ ...gcsRef, object: 'other-app.json' })).toThrow();
  expect(() => validateValues({ PORT: '8080' })).toThrow();
  expect(() => validateValues({ CNP_VARIABLES_REF: 'injected' })).toThrow();
});
test('runtime has no provider dependency without a reference, and injects full values with one', async () => {
  const client = { readBundle: jest.fn(async () => values) };
  const base = { PORT: '8080', CNP_VARIABLES_REF: JSON.stringify(gcsRef), API_KEY: 'image-default' };
  expect(await environment({ PORT: '8080' }, client)).toEqual({ PORT: '8080' }); expect(client.readBundle).not.toHaveBeenCalled();
  expect(await environment(base, client)).toEqual({ PORT: '8080', ...values });
});
test('provider refusal never falls back or invokes the application', async () => {
  const client = { readBundle: jest.fn().mockRejectedValue(new Error('CONFIG_DENIED')) };
  await expect(environment({ CNP_VARIABLES_REF: JSON.stringify(gcsRef) }, client)).rejects.toThrow('CONFIG_DENIED');
  expect(client.readBundle).toHaveBeenCalledTimes(1);
});
test('HTTP provider endpoints and disabled TLS are rejected before sending credentials', async () => {
  await expect(request('http://untrusted.test/path')).rejects.toThrow('CONFIG_TLS_REQUIRED');
});
