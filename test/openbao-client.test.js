'use strict';

const { OpenBaoClient, googleIdentityToken } = require('../src/services/openbao-client');

function fake() {
  const transport = { get: jest.fn(), post: jest.fn().mockResolvedValue({ data: { auth: { client_token: 'temporary-token' } } }),
    request: jest.fn().mockResolvedValue({ data: { data: { version: 1 } } }) };
  const client = new OpenBaoClient({ domain: 'gcp', address: 'https://openbao.test:8200',
    transport, identityToken: jest.fn().mockResolvedValue('signed-google-jwt') });
  return { client, transport };
}

test('authenticates with a Google identity and writes an app/environment KV v2 version with CAS', async () => {
  const { client, transport } = fake();
  expect(await client.write('sample-app', 'dev', { API_URL: 'https://example.test', EMPTY: '' }, 0)).toBe(1);
  expect(transport.post).toHaveBeenCalledWith('https://openbao.test:8200/v1/auth/jwt/login',
    { role: 'cnp-control', jwt: 'signed-google-jwt' }, expect.objectContaining({ maxRedirects: 0 }));
  expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST',
    url: 'https://openbao.test:8200/v1/cnp-runtime/data/apps/sample-app/dev',
    headers: { 'X-Vault-Token': 'temporary-token' },
    data: { options: { cas: 0 }, data: { API_URL: 'https://example.test', EMPTY: '' } } }));
});

test('reads only the requested version and returns values internally', async () => {
  const { client, transport } = fake();
  transport.request.mockResolvedValue({ data: { data: { data: { API_KEY: 'private' }, metadata: { version: 3 } } } });
  expect(await client.read('sample-app', 'prod', 3)).toEqual({ values: { API_KEY: 'private' }, version: 3 });
  expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', params: { version: 3 },
    url: 'https://openbao.test:8200/v1/cnp-runtime/data/apps/sample-app/prod' }));
});

test('destroys only the provisional version requested by the coordinator', async () => {
  const { client, transport } = fake();
  await client.destroyVersion('sample-app', 'prod', 4);
  expect(transport.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST',
    url: 'https://openbao.test:8200/v1/cnp-runtime/destroy/apps/sample-app/prod', data: { versions: [4] } }));
  await expect(client.destroyVersion('sample-app', 'prod', 0)).rejects.toThrow('Version OpenBao invalide');
});

test('rejects insecure endpoints, path traversal and unsafe values before any HTTP call', async () => {
  expect(() => new OpenBaoClient({ domain: 'gcp', address: 'http://openbao.test' })).toThrow('HTTPS');
  const { client, transport } = fake();
  await expect(client.write('../other', 'dev', { OK: 'value' }, 0)).rejects.toThrow('Chemin');
  await expect(client.write('sample-app', 'dev', { 'BAD-NAME': 'value' }, 0)).rejects.toThrow('Variables');
  await expect(client.write('sample-app', 'dev', { OK: 'value' }, -1)).rejects.toThrow('Variables');
  expect(transport.post).not.toHaveBeenCalled();
});

test('never propagates a failed request body or OpenBao error details', async () => {
  const { client, transport } = fake();
  transport.request.mockRejectedValue(Object.assign(new Error('API_KEY=private'), { response: { status: 403,
    data: { errors: ['API_KEY=private'] } } }));
  await expect(client.write('sample-app', 'dev', { API_KEY: 'private' }, 0))
    .rejects.toThrow('OpenBao gcp indisponible ou accès refusé (HTTP 403).');
});

test('obtains a scoped identity token from the Google metadata server', async () => {
  const transport = { get: jest.fn().mockResolvedValue({ data: 'jwt' }) };
  expect(await googleIdentityToken('https://openbao.test:8200', transport)).toBe('jwt');
  expect(transport.get).toHaveBeenCalledWith(expect.stringContaining('metadata.google.internal'),
    expect.objectContaining({ headers: { 'Metadata-Flavor': 'Google' },
      params: { audience: 'https://openbao.test:8200', format: 'full' } }));
});
