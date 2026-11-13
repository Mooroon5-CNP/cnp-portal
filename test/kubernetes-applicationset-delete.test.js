'use strict';

jest.mock('../src/config/env', () => ({ config: { kubernetes: {
  apiUrl: 'https://cluster.example.test', token: 'test-token', caCert: 'dGVzdA==',
} } }));
jest.mock('request', () => jest.fn((options, callback) => callback(null, { statusCode: 200 }, {})));

const request = require('request');
const { deleteApplicationSet } = require('../src/clients/kubernetes');

beforeEach(() => request.mockClear());

test.each(['cloudrun-autodiscovery', 'crossplane-autodiscovery-dev', 'crossplane-autodiscovery-prod'])(
  'shared ApplicationSet %s is never deleted',
  async name => {
    await expect(deleteApplicationSet(name)).rejects.toThrow('ApplicationSet partagé');
    expect(request).not.toHaveBeenCalled();
  },
);

test('a per-app ApplicationSet is deleted through the Kubernetes API', async () => {
  await expect(deleteApplicationSet('myapp-dev')).resolves.toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  const [options] = request.mock.calls[0];
  expect(options.method).toBe('DELETE');
  expect(options.uri).toBe('https://cluster.example.test/apis/argoproj.io/v1alpha1/namespaces/argocd/applicationsets/myapp-dev');
});
