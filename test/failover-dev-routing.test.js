'use strict';
const mockApi = { getNamespacedCustomObject: jest.fn(), createNamespacedCustomObject: jest.fn() };
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({ loadFromOptions: jest.fn(), makeApiClient: () => mockApi })),
  CustomObjectsApi: jest.fn(),
}));
jest.mock('../src/config/env', () => ({ config: { kubernetes: { apiUrl: 'https://cluster.test', caCert: 'ca', token: 'token' } } }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn() }));
jest.mock('../src/clients/argocd', () => ({ syncApplication: jest.fn() }));
const github = require('../src/clients/github');
const argocd = require('../src/clients/argocd');
const { repair } = require('../src/services/failover-dev-routing');
const manager = { id: 'manager', role: 'manager' };
beforeEach(() => {
  jest.clearAllMocks();
  github.getInstallationOctokit.mockResolvedValue({ request: jest.fn().mockResolvedValue({ data: { object: { sha: 'a'.repeat(40) } } }) });
  mockApi.getNamespacedCustomObject.mockRejectedValue({ statusCode: 404 });
});
test('restaure uniquement le backend déclaré, sans sync automatique ni prune', async () => {
  const result = await repair(manager);
  const manifest = mockApi.createNamespacedCustomObject.mock.calls[0][4];
  expect(manifest.metadata).toEqual({ name: 'app4-pixelcam-dev', namespace: 'argocd' });
  expect(manifest.spec.syncPolicy.automated).toBeUndefined();
  expect(manifest.spec.source.path).toBe('apps/app4-pixelcam/crossplane/dev');
  expect(manifest.spec.source.targetRevision).toBe('a'.repeat(40));
  expect(argocd.syncApplication).toHaveBeenCalledWith('app4-pixelcam-dev', [{ group: 'compute.gcp.upbound.io', kind: 'BackendService', name: 'cnp-app4-pixelcam-dev-backend' }]);
  expect(result.prune).toBe(false);
});
test('ne remplace jamais une Application existante inattendue', async () => {
  mockApi.getNamespacedCustomObject.mockResolvedValue({ body: { metadata: {}, spec: { project: 'another-team' } } });
  await expect(repair(manager)).rejects.toThrow('inattendue');
  expect(mockApi.createNamespacedCustomObject).not.toHaveBeenCalled();
  expect(argocd.syncApplication).not.toHaveBeenCalled();
});
test('refuse les comptes non manager avant tout accès', async () => {
  await expect(repair({ id: 'dev', role: 'dev' })).rejects.toThrow('manager');
  expect(github.getInstallationOctokit).not.toHaveBeenCalled();
});
