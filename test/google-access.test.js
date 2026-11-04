'use strict';
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('fs', () => ({ readFileSync: jest.fn() }));
const fs = require('fs'); const axios = require('axios');
beforeEach(() => { jest.clearAllMocks(); fs.readFileSync.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }); });
function client() { let result; jest.isolateModules(() => { result = require('../src/clients/google-access'); }); return result; }
test('managed runtime uses metadata identity, never follows redirects, and caches its short-lived token', async () => {
  axios.get.mockImplementation(async url => ({ data: url.endsWith('/email') ? 'portal@test-project.iam.gserviceaccount.com' : { access_token: 'private-metadata-token', expires_in: 3600 } }));
  const auth = client();
  expect(await auth.token()).toBe('private-metadata-token'); expect(await auth.token()).toBe('private-metadata-token');
  expect(axios.get).toHaveBeenCalledTimes(2);
  expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/^http:\/\/metadata.google.internal\//), expect.objectContaining({ proxy: false, maxRedirects: 0, headers: { 'Metadata-Flavor': 'Google' } }));
});
test('operator-provisioned local ADC exchanges a refresh token only with Google', async () => {
  fs.readFileSync.mockReturnValue(JSON.stringify({ type: 'authorized_user', client_id: 'fixture-client', client_secret: 'private-secret', refresh_token: 'private-refresh' }));
  axios.post.mockResolvedValue({ data: { access_token: 'short-lived', expires_in: 3600 } });
  expect(await client().token()).toBe('short-lived');
  expect(axios.get).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.stringContaining('grant_type=refresh_token'), expect.objectContaining({ timeout: 10000 }));
});
test('upstream errors never expose credentials, payloads, or full Axios errors', async () => {
  axios.get.mockRejectedValue(new Error('private-token and private credentials'));
  await expect(client().token()).rejects.toThrow('Identité GCP');
  try { await client().token(); } catch (error) { expect(error.message).not.toContain('private'); }
});

test('local ADC quota project is forwarded without exposing refresh credentials', async () => {
  fs.readFileSync.mockReturnValue(JSON.stringify({ type: 'authorized_user', client_id: 'fixture-client', client_secret: 'private-secret', refresh_token: 'private-refresh', quota_project_id: 'test-project' }));
  axios.post.mockResolvedValue({ data: { access_token: 'short-lived', expires_in: 3600 } });
  expect(await client().headers()).toEqual({ Authorization: 'Bearer short-lived', 'x-goog-user-project': 'test-project' });
});
