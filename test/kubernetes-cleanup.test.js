'use strict';

jest.mock('../src/config/env', () => ({ config: { kubernetes: {
  apiUrl: 'https://cluster.example.test', token: 'test-token', caCert: 'dGVzdA==',
} } }));
jest.mock('request', () => jest.fn());
const request = require('request');
const { getCleanupResource } = require('../src/clients/kubernetes');
const bucket = { apiVersion: 'storage.gcp.upbound.io/v1beta1', kind: 'Bucket', name: 'app-dev-data' };
beforeEach(() => jest.resetAllMocks());

test('cleanup reads the exact allowed managed resource', async () => {
  request.mockImplementation((options, callback) => callback(null, { statusCode: 200 }, { metadata: { name: bucket.name } }));
  expect(await getCleanupResource(bucket)).toMatchObject({ metadata: { name: bucket.name } });
  expect(request.mock.calls[0][0].uri).toBe('https://cluster.example.test/apis/storage.gcp.upbound.io/v1beta1/buckets/app-dev-data');
});
test('404 means absent, but 403 is an error', async () => {
  request.mockImplementation((_options, callback) => callback(null, { statusCode: 404 }, {}));
  expect(await getCleanupResource(bucket)).toBeNull();
  request.mockImplementation((_options, callback) => callback(null, { statusCode: 403 }, {}));
  await expect(getCleanupResource(bucket)).rejects.toThrow('permissions');
});
test('arbitrary resource kinds and paths cannot be requested', async () => {
  await expect(getCleanupResource({ apiVersion: 'v1', kind: 'Secret', name: 'secret' })).rejects.toThrow('non autorisée');
  await expect(getCleanupResource({ ...bucket, name: '../other' })).rejects.toThrow('non autorisée');
  expect(request).not.toHaveBeenCalled();
});
