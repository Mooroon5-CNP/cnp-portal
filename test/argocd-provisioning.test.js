'use strict';

jest.mock('../src/clients/argocd', () => ({}));
jest.mock('../src/clients/kubernetes', () => ({ provisionArgoCDLocalUser: jest.fn() }));
jest.mock('../src/models/argocd_access_request', () => ({ getById: jest.fn(), getApprovedForUser: jest.fn(), approve: jest.fn(), updateCredentials: jest.fn() }));
jest.mock('../src/models/user', () => ({ findById: jest.fn() }));

const k8s = require('../src/clients/kubernetes');
const requests = require('../src/models/argocd_access_request');
const users = require('../src/models/user');
const service = require('../src/services/argocd');

beforeEach(() => {
  jest.resetAllMocks();
  requests.getById.mockReturnValue({ id: 'request', status: 'pending', userId: 'user' });
  users.findById.mockReturnValue({ id: 'user', username: 'developer' });
  k8s.provisionArgoCDLocalUser.mockRejectedValue(new Error('Kubernetes forbidden'));
});

test('failed cluster provisioning leaves an approval pending', async () => {
  await expect(service.approveAccess('request', 'manager')).rejects.toThrow('Kubernetes forbidden');
  expect(requests.approve).not.toHaveBeenCalled();
});

test('failed credential regeneration preserves existing credentials', async () => {
  requests.getApprovedForUser.mockReturnValue({ id: 'request', argoCDUsername: 'developer' });
  await expect(service.regenerateCredentials('user')).rejects.toThrow('Kubernetes forbidden');
  expect(requests.updateCredentials).not.toHaveBeenCalled();
});

test('successful cluster provisioning is followed by approval with encrypted credentials', async () => {
  k8s.provisionArgoCDLocalUser.mockResolvedValue();
  await service.approveAccess('request', 'manager');
  expect(requests.approve).toHaveBeenCalledWith('request', expect.objectContaining({ argoCDUsername: 'developer', reviewedBy: 'manager' }));
});

test('regeneration replaces unreadable credentials with a password the portal can display', async () => {
  let stored = { id: 'request', argoCDUsername: 'developer', argoCDPassword: 'unreadable-old-ciphertext' };
  requests.getApprovedForUser.mockImplementation(() => ({ ...stored }));
  requests.updateCredentials.mockImplementation((_id, values) => { stored = { ...stored, ...values }; return stored; });
  k8s.provisionArgoCDLocalUser.mockResolvedValue();
  expect(service.getUserAccessRequest('user').argoCDPassword).toBeNull();
  await service.regenerateCredentials('user');
  const shown = service.getUserAccessRequest('user').argoCDPassword;
  expect(shown).toHaveLength(16);
  expect(require('bcryptjs').compareSync(shown, k8s.provisionArgoCDLocalUser.mock.calls[0][1])).toBe(true);
});
