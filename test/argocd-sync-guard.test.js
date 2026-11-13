'use strict';

jest.mock('../src/clients/argocd', () => ({ syncApplication: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({}));
jest.mock('../src/models/argocd_access_request', () => ({}));
jest.mock('../src/models/user', () => ({}));
jest.mock('../src/models/deployment', () => ({ listForUser: jest.fn() }));

const client = require('../src/clients/argocd');
const deployments = require('../src/models/deployment');
const service = require('../src/services/argocd');

beforeEach(() => {
  jest.resetAllMocks();
  deployments.listForUser.mockReturnValue([{ app_name: 'app4-pixelcam' }]);
  client.syncApplication.mockResolvedValue({ name: 'synced' });
});

test.each(['app4-pixelcam-cloudrun', 'app4-pixelcam-dev', 'app4-pixelcam-prod'])(
  'portal-managed application %s can be synced',
  async name => {
    await service.syncApp(name);
    expect(client.syncApplication).toHaveBeenCalledWith(name);
  },
);

test.each(['crossplane-providers', 'crossplane-config', 'cnp-application-routing', 'ingress-nginx', 'other-app-dev', 'app4-pixelcam'])(
  '%s is refused without calling Argo CD',
  async name => {
    await expect(service.syncApp(name)).rejects.toThrow('non gérée par le portail');
    expect(client.syncApplication).not.toHaveBeenCalled();
  },
);
