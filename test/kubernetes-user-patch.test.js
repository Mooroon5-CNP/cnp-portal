'use strict';

// Exercise the installed SDK's HTTP serialization, including optional argument positions.
jest.mock('../src/config/env', () => ({ config: { kubernetes: {
  apiUrl: 'https://cluster.example.test', token: 'test-token', caCert: 'dGVzdA==',
} } }));
jest.mock('request', () => jest.fn((options, callback) => {
  if (options.headers['Content-Type'] !== 'application/merge-patch+json') {
    callback(null, { statusCode: 415 }, { message: 'Unsupported Media Type' });
  } else {
    callback(null, { statusCode: 200 }, {});
  }
}));

const request = require('request');
const { provisionArgoCDLocalUser } = require('../src/clients/kubernetes');

beforeEach(() => request.mockClear());

test('account provisioning sends both patches as merge-patch JSON through the real SDK', async () => {
  await expect(provisionArgoCDLocalUser('developer', 'test-bcrypt-hash')).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
  const sent = request.mock.calls.map(([options]) => options);
  expect(sent.map(options => options.uri)).toEqual([
    'https://cluster.example.test/api/v1/namespaces/argocd/configmaps/argocd-cm',
    'https://cluster.example.test/api/v1/namespaces/argocd/secrets/argocd-secret',
  ]);
  for (const options of sent) {
    expect(options.headers['Content-Type']).toBe('application/merge-patch+json');
    expect(options.qs.force).toBeUndefined();
    expect(options.timeout).toBe(10000);
  }
  expect(sent[1].body.data['accounts.developer.password']).toBe(Buffer.from('test-bcrypt-hash').toString('base64'));
});

test.each(['admin', 'cnp-portal', 'dev.enabled', ''])('reserved or malformed account %p is refused before any patch', async name => {
  await expect(provisionArgoCDLocalUser(name, 'test-bcrypt-hash')).rejects.toThrow('Nom de compte Argo CD refusé');
  expect(request).not.toHaveBeenCalled();
});

test('live diagnostics send the same account patches in Kubernetes dry-run mode', async () => {
  await provisionArgoCDLocalUser('developer', 'test-bcrypt-hash', { dryRun: true });
  expect(request).toHaveBeenCalledTimes(2);
  for (const [options] of request.mock.calls) expect(options.qs.dryRun).toBe('All');
});

afterEach(() => jest.useRealTimers());
test('network timeout during account activation stops before the password patch', async () => {
  jest.useFakeTimers();
  request.mockImplementationOnce((options, callback) => {
    setTimeout(() => callback(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' })), options.timeout);
  });
  const rejected = expect(provisionArgoCDLocalUser('developer', 'test-bcrypt-hash')).rejects.toThrow('étape argocd-cm');
  await jest.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
});
test('password-patch timeout identifies the partially completed stage', async () => {
  jest.useFakeTimers();
  request.mockImplementationOnce((_options, callback) => callback(null, { statusCode: 200 }, {}));
  request.mockImplementationOnce((options, callback) => {
    setTimeout(() => callback(Object.assign(new Error('read timeout'), { code: 'ESOCKETTIMEDOUT' })), options.timeout);
  });
  const rejected = expect(provisionArgoCDLocalUser('developer', 'test-bcrypt-hash')).rejects.toThrow('étape argocd-secret');
  await jest.advanceTimersByTimeAsync(10000);
  await rejected;
  expect(request).toHaveBeenCalledTimes(2);
});
