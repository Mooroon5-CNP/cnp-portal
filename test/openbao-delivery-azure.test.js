'use strict';

const fs = require('fs');
const { AzureVariableDelivery, federatedAccessToken, secretName } = require('../src/services/openbao-delivery-azure');

const tenantId = '11111111-1111-1111-1111-111111111111';
const clientId = '22222222-2222-2222-2222-222222222222';
const vaultUrl = 'https://cnp-test.vault.azure.net';
const dep = { appName: 'sample-app', environment: 'dev', targetCluster: 'azure' };

test('writes a new version to Key Vault and returns a pinned reference without the value', async () => {
  const id = secretName(dep, 'API_KEY');
  const version = 'a'.repeat(32);
  const transport = { get: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { response: { status: 404 } })),
    put: jest.fn().mockResolvedValue({ data: { id: `${vaultUrl}/secrets/${id}/${version}` } }) };
  const adapter = new AzureVariableDelivery({ vaultUrl, tenantId, clientId, tokenFile: '/projected-token', transport,
    accessToken: jest.fn().mockResolvedValue('access-token') });
  const refs = await adapter.deliver(dep, { API_KEY: 'private-value' });
  expect(refs).toEqual([{ name: 'API_KEY', secretName: id, keyVaultSecretId: `${vaultUrl}/secrets/${id}/${version}` }]);
  expect(transport.put.mock.calls[0][1]).toEqual({ value: 'private-value',
    tags: { cnp_app: dep.appName, cnp_env: dep.environment, cnp_owner: 'portal_variables' } });
  expect(JSON.stringify(refs)).not.toContain('private-value');
});

test('recovers its own soft-deleted secret (re-created app) and then writes the new version', async () => {
  const id = secretName(dep, 'API_KEY');
  const version = 'b'.repeat(32);
  const missing = Object.assign(new Error('missing'), { response: { status: 404 } });
  const deleted = Object.assign(new Error('conflict'), { response: { status: 409, data: { error: { code: 'ObjectIsDeletedButRecoverable' } } } });
  const ownTags = { cnp_app: dep.appName, cnp_env: dep.environment, cnp_owner: 'portal_variables' };
  let recovered = false;
  const transport = {
    get: jest.fn(async (url) => {
      if (url.includes('/deletedsecrets/')) return { data: { tags: ownTags } };
      if (recovered) return { data: { tags: ownTags } };
      throw missing;
    }),
    post: jest.fn(async () => { recovered = true; return { data: {} }; }),
    put: jest.fn().mockRejectedValueOnce(deleted).mockResolvedValue({ data: { id: `${vaultUrl}/secrets/${id}/${version}` } }),
  };
  const adapter = new AzureVariableDelivery({ vaultUrl, tenantId, clientId, tokenFile: '/projected-token', transport,
    accessToken: jest.fn().mockResolvedValue('access-token'), recoverDelayMs: 0 });
  const refs = await adapter.deliver(dep, { API_KEY: 'new-value' });
  expect(transport.post).toHaveBeenCalledWith(`${vaultUrl}/deletedsecrets/${id}/recover?api-version=7.4`, null, expect.any(Object));
  expect(transport.put).toHaveBeenCalledTimes(2);
  expect(refs[0].keyVaultSecretId).toBe(`${vaultUrl}/secrets/${id}/${version}`);
});

test('never recovers a soft-deleted secret outside the portal scope, nor on another 409', async () => {
  const deleted = Object.assign(new Error('conflict'), { response: { status: 409, data: { error: { code: 'ObjectIsDeletedButRecoverable' } } } });
  const missing = Object.assign(new Error('missing'), { response: { status: 404 } });
  const foreign = { get: jest.fn(async (url) => { if (url.includes('/deletedsecrets/')) return { data: { tags: { cnp_app: 'other-app' } } }; throw missing; }),
    post: jest.fn(), put: jest.fn().mockRejectedValue(deleted) };
  const options = { vaultUrl, tenantId, clientId, tokenFile: '/projected-token', accessToken: jest.fn().mockResolvedValue('t'), recoverDelayMs: 0 };
  await expect(new AzureVariableDelivery({ ...options, transport: foreign }).deliver(dep, { API_KEY: 'v' })).rejects.toThrow('hors du périmètre');
  expect(foreign.post).not.toHaveBeenCalled();
  const other = { get: jest.fn().mockRejectedValue(missing), post: jest.fn(),
    put: jest.fn().mockRejectedValue(Object.assign(new Error('conflict'), { response: { status: 409, data: { error: { code: 'Conflict' } } } })) };
  await expect(new AzureVariableDelivery({ ...options, transport: other }).deliver(dep, { API_KEY: 'v' })).rejects.toThrow('HTTP 409');
  expect(other.post).not.toHaveBeenCalled();
});

test('never overwrites a Key Vault secret outside the portal scope', async () => {
  const transport = { get: jest.fn().mockResolvedValue({ data: { tags: { cnp_app: 'other-app' } } }), put: jest.fn() };
  const adapter = new AzureVariableDelivery({ vaultUrl, tenantId, clientId, tokenFile: '/projected-token', transport,
    accessToken: jest.fn().mockResolvedValue('access-token') });
  await expect(adapter.deliver(dep, { API_KEY: 'private-value' })).rejects.toThrow('hors du périmètre');
  expect(transport.put).not.toHaveBeenCalled();
});

test('exchanges the projected Kubernetes token for a Key Vault token', async () => {
  jest.spyOn(fs, 'readFileSync').mockReturnValue('projected-jwt');
  const transport = { post: jest.fn().mockResolvedValue({ data: { access_token: 'azure-token' } }) };
  try {
    expect(await federatedAccessToken({ tenantId, clientId, tokenFile: '/projected-token', transport })).toBe('azure-token');
    const [url, body] = transport.post.mock.calls[0];
    expect(url).toContain(tenantId);
    expect(new URLSearchParams(body).get('client_assertion')).toBe('projected-jwt');
    expect(new URLSearchParams(body).get('scope')).toBe('https://vault.azure.net/.default');
  } finally { jest.restoreAllMocks(); }
});
