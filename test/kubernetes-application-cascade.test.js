'use strict';
jest.mock('../src/config/env', () => ({ config: { kubernetes: { apiUrl: 'https://cluster.test', token: 'fixture', caCert: 'dGVzdA==' } } }));
jest.mock('request', () => jest.fn());
const request = require('request');
const { cascadeDeleteArgocdApplication } = require('../src/clients/kubernetes');
beforeEach(() => request.mockReset());
test('cascade uses merge patch, preserves finalizers and resource version, then deletes', async () => {
  request.mockImplementation((options, callback) => callback(null, { statusCode: 200 }, options.method === 'GET'
    ? { metadata: { finalizers: ['other-controller'], resourceVersion: '12' } } : {}));
  await expect(cascadeDeleteArgocdApplication('app-dev')).resolves.toBe(true);
  expect(request.mock.calls.map(([options]) => options.method)).toEqual(['GET', 'PATCH', 'DELETE']);
  const patch = request.mock.calls[1][0];
  expect(patch.headers['Content-Type']).toBe('application/merge-patch+json');
  expect(patch.body.metadata).toEqual({ finalizers: ['other-controller', 'resources-finalizer.argocd.argoproj.io'], resourceVersion: '12' });
  expect(request.mock.calls.every(([options]) => options.timeout === 10000)).toBe(true);
});
test('missing application is an idempotent no-op', async () => {
  request.mockImplementation((_options, callback) => callback(null, { statusCode: 404 }, {}));
  await expect(cascadeDeleteArgocdApplication('missing-dev')).resolves.toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
test('permission refusal is not ignored and never reaches DELETE', async () => {
  request.mockImplementation((_options, callback) => callback(null, { statusCode: 403 }, {}));
  await expect(cascadeDeleteArgocdApplication('forbidden-dev')).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
});
