'use strict';
jest.mock('../src/config/env', () => ({ config: { kubernetes: { apiUrl: 'https://cluster.test', token: 'test', caCert: 'dGVzdA==' } } }));
const mockApi = { getNamespacedCustomObject: jest.fn(), replaceNamespacedCustomObject: jest.fn(), patchNamespacedCustomObject: jest.fn() };
jest.mock('@kubernetes/client-node', () => ({ KubeConfig: jest.fn(() => ({ loadFromOptions: jest.fn(), makeApiClient: () => mockApi })), CustomObjectsApi: jest.fn() }));
const { applyApplicationSet } = require('../src/clients/kubernetes');
test('la mise à jour utilise le verbe autorisé, conserve les membres et refuse les mises à jour concurrentes via resourceVersion', async () => {
  const existing = { apiVersion: 'argoproj.io/v1alpha1', kind: 'ApplicationSet', metadata: { name: 'crossplane-autodiscovery-prod', uid: 'same-object', resourceVersion: '42' }, spec: {
    generators: [{ git: { repoURL: 'https://github.com/Mooroon5-CNP/config-repo.git', revision: 'main', directories: [{ path: 'apps/member/crossplane/prod' }] } }],
    template: { spec: { project: 'team-cnp-prod', syncPolicy: { automated: { prune: false } } } }, ignoreApplicationDifferences: [{ name: 'member-prod', jsonPointers: ['/spec/syncPolicy'] }],
  } };
  mockApi.getNamespacedCustomObject.mockResolvedValue({ body: existing });
  await applyApplicationSet({ metadata: { name: existing.metadata.name }, spec: { generators: [{ git: { directories: [{ path: 'apps/new/crossplane/prod' }] } }] } });
  expect(mockApi.patchNamespacedCustomObject).not.toHaveBeenCalled();
  const updated = mockApi.replaceNamespacedCustomObject.mock.calls[0][5];
  expect(updated.metadata).toEqual(existing.metadata);
  expect(updated.spec.template).toEqual(existing.spec.template);
  expect(updated.spec.ignoreApplicationDifferences).toEqual(existing.spec.ignoreApplicationDifferences);
  expect(updated.spec.generators[0].git.directories).toEqual([{ path: 'apps/member/crossplane/prod' }, { path: 'apps/new/crossplane/prod' }]);
  expect(existing.spec.generators[0].git.directories).toHaveLength(1);
});
