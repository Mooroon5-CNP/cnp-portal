'use strict';

jest.mock('../src/clients/argocd', () => ({}));
jest.mock('../src/clients/kubernetes', () => ({ provisionArgoCDLocalUser: jest.fn() }));
jest.mock('../src/models/argocd_access_request', () => ({ getById: jest.fn(), getApprovedForUser: jest.fn(), approve: jest.fn(), reject: jest.fn(), listPending: jest.fn(), updateCredentials: jest.fn() }));
jest.mock('../src/models/user', () => ({ findById: jest.fn() }));

const k8s = require('../src/clients/kubernetes');
const requests = require('../src/models/argocd_access_request');
const users = require('../src/models/user');
const service = require('../src/services/argocd');

beforeEach(() => {
  jest.resetAllMocks();
  requests.getById.mockReturnValue({ id: 'request', status: 'pending', userId: 'user' });
  users.findById.mockImplementation(id => id === 'manager'
    ? { id: 'manager', username: 'reviewer', role: 'manager', active: true, githubId: 42 }
    : { id: 'user', username: 'developer', role: 'dev', active: true, githubId: 43 });
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

test('a manager cannot approve or reject their own access even through a direct service call', async () => {
  requests.getById.mockReturnValue({ id: 'self', status: 'pending', userId: 'manager' });
  await expect(service.approveAccess('self', 'manager')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(() => service.rejectAccess('self', 'manager')).toThrow('aucune auto-approbation');
  expect(k8s.provisionArgoCDLocalUser).not.toHaveBeenCalled();
  expect(requests.approve).not.toHaveBeenCalled();
  expect(requests.reject).not.toHaveBeenCalled();
});
test('ordinary managers cannot approve another manager; an OAuth admin name is not root', async () => {
  users.findById.mockImplementation(id => ({ id, username: 'admin', role: 'manager', active: true, githubId: 42 }));
  await expect(service.approveAccess('request', 'manager')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(k8s.provisionArgoCDLocalUser).not.toHaveBeenCalled();
  expect(requests.approve).not.toHaveBeenCalled();
});
test('the local admin can approve another manager after cluster provisioning succeeds', async () => {
  users.findById.mockImplementation(id => id === 'root'
    ? { id, username: 'admin', role: 'manager', active: true, githubId: null }
    : { id, username: 'team-manager', role: 'manager', active: true, githubId: 42 });
  k8s.provisionArgoCDLocalUser.mockResolvedValue();
  await service.approveAccess('request', 'root');
  expect(requests.approve).toHaveBeenCalledWith('request', expect.objectContaining({ reviewedBy: 'root' }));
});
test('the review list excludes self and manager requests for an ordinary manager', () => {
  users.findById.mockImplementation(id => ({ id, username: id, active: true, githubId: 42, role: id === 'dev' ? 'dev' : 'manager' }));
  requests.listPending.mockReturnValue([{ userId: 'reviewer' }, { userId: 'other-manager' }, { userId: 'dev' }]);
  expect(service.getAccessRequests('reviewer')).toEqual([{ userId: 'dev' }]);
});
