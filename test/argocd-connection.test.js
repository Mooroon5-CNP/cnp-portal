'use strict';

jest.mock('../src/config/env', () => ({ config: { argocd: {
  serverUrl: 'https://argocd.example.test', token: '', username: 'cnp-portal', password: 'test-password', insecure: false,
} } }));

let client;
let adapter;
let config;
beforeEach(() => {
  jest.resetModules();
  const axios = require('axios');
  adapter = jest.fn(async request => {
    const data = request.url === '/session' ? { token: 'session-token' } : { items: [] };
    return { status: 200, data, config: request, headers: {} };
  });
  axios.defaults.adapter = adapter;
  config = require('../src/config/env').config;
  client = require('../src/clients/argocd');
});

test('Terraform login obtains a session once and sends it to Argo CD', async () => {
  await client.listApplications();
  await client.checkConnectivity();
  expect(adapter.mock.calls.map(([request]) => request.url)).toEqual(['/session', '/applications', '/applications']);
  expect(adapter.mock.calls[1][0].headers.Authorization).toBe('Bearer session-token');
});

test('existing API token is still used without a password login', async () => {
  config.argocd.token = 'legacy-token';
  await client.listApplications();
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(adapter.mock.calls[0][0].headers.Authorization).toBe('Bearer legacy-token');
});

test('expired login session is renewed and original request is retried once', async () => {
  let rejected = false;
  adapter.mockImplementation(async request => {
    if (request.url === '/applications' && !rejected) {
      rejected = true;
      throw Object.assign(new Error('expired'), { config: request, response: { status: 401 } });
    }
    return { status: 200, data: request.url === '/session' ? { token: 'renewed' } : { items: [] }, config: request, headers: {} };
  });
  await expect(client.listApplications()).resolves.toEqual([]);
  expect(adapter.mock.calls.map(([request]) => request.url)).toEqual(['/session', '/applications', '/session', '/applications']);
});

test('persistent 401 stops after one renewal', async () => {
  adapter.mockImplementation(async request => {
    if (request.url === '/session') return { status: 200, data: { token: 'session' }, config: request, headers: {} };
    throw Object.assign(new Error('denied'), { config: request, response: { status: 401 } });
  });
  await expect(client.listApplications()).rejects.toThrow('authentication failed');
  expect(adapter).toHaveBeenCalledTimes(4);
});
