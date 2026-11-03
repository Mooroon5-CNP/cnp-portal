'use strict';

jest.mock('../src/config/env', () => ({ config: { kubernetes: {
  apiUrl: 'https://cluster.example.test', token: 'fixture', caCert: 'dGVzdA==',
} } }));
jest.mock('request', () => jest.fn());
const request = require('request');
const { getArgocdApplicationIfExists } = require('../src/clients/kubernetes');
beforeEach(() => request.mockReset());
test('a real Kubernetes 404 is the only missing-application outcome', async () => {
  request.mockImplementation((_options, callback) => callback(null, { statusCode: 404 }, { message: 'Not found' }));
  await expect(getArgocdApplicationIfExists('cnp-portal-cloudrun')).resolves.toBeNull();
  const options = request.mock.calls[0][0];
  expect(options.uri).toBe('https://cluster.example.test/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/cnp-portal-cloudrun');
  expect(options.method).toBe('GET');
  expect(options.timeout).toBe(10000);
});
test.each([401, 403, 500])('HTTP %s is never treated as application absence', async statusCode => {
  request.mockImplementation((_options, callback) => callback(null, { statusCode }, { message: 'Unavailable' }));
  await expect(getArgocdApplicationIfExists('cnp-portal-cloudrun')).rejects.toThrow();
});
test('an existing Application is returned so onboarding can reject unsafe adoption', async () => {
  const body = { metadata: { name: 'existing-cloudrun' } };
  request.mockImplementation((_options, callback) => callback(null, { statusCode: 200 }, body));
  await expect(getArgocdApplicationIfExists('existing-cloudrun')).resolves.toEqual(body);
});
