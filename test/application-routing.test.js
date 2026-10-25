'use strict';
jest.mock('../src/config/env', () => ({ config: { gcp: { project: 'test-project', region: 'europe-west9' } } }));
jest.mock('../src/clients/kubernetes', () => ({ getComputeResource: jest.fn() }));
jest.mock('axios', () => ({ get: jest.fn() }));
const yaml = require('js-yaml');
const axios = require('axios');
const k8s = require('../src/clients/kubernetes');
const routing = require('../src/services/application-routing');
const dep = { appName: 'pixelcam', environment: 'dev' };
function baseline() {
  return { apiVersion: 'compute.gcp.upbound.io/v1beta1', kind: 'URLMap', metadata: {
    name: 'cnp-application-routing', annotations: { 'crossplane.io/external-name': 'cnp-apps-urlmap' },
  }, spec: { deletionPolicy: 'Orphan', managementPolicies: ['Observe', 'Update'], forProvider: { project: 'test-project', defaultService: 'legacy-backend',
    hostRule: [{ hosts: ['existing.example.test'], pathMatcher: 'existing' }],
    pathMatcher: [{ name: 'existing', defaultService: 'existing-backend' }], description: 'Keep this field' } } };
}
function ready(atProvider) { return { status: { atProvider, conditions: ['Ready', 'Synced'].map(type => ({ type, status: 'True' })) } }; }
beforeEach(() => jest.clearAllMocks());
test('network points at fixed environment services with separate dev/prod backends', () => {
  const [neg, backend] = yaml.loadAll(routing.network(dep));
  expect(neg.spec.forProvider.cloudRun).toEqual([{ service: 'pixelcam-dev' }]);
  expect(neg.spec.forProvider.cloudRun[0].urlMask).toBeUndefined();
  expect(backend.spec.forProvider.backend[0].group).toContain('/cnp-pixelcam-dev-neg');
  expect(routing.network({ ...dep, environment: 'prod' })).toContain('pixelcam-prod');
});
test('adding and removing a route preserve default backend, other rules and unrelated fields', () => {
  const original = baseline();
  const added = routing.updateMap(original, dep);
  expect(original.spec.forProvider.hostRule).toHaveLength(1);
  expect(added.spec.forProvider).toMatchObject({ defaultService: 'legacy-backend', description: 'Keep this field' });
  expect(added.spec.forProvider.hostRule).toContainEqual({ hosts: ['pixelcam.dev.apps.mooroon5.fr'], pathMatcher: 'cnp-pixelcam-dev' });
  const prod = routing.updateMap(added, { ...dep, environment: 'prod' });
  const removed = routing.updateMap(prod, dep, true);
  expect(removed.spec.forProvider.hostRule).toContainEqual({ hosts: ['pixelcam.apps.mooroon5.fr'], pathMatcher: 'cnp-pixelcam-prod' });
  expect(removed.spec.forProvider.hostRule).toContainEqual(original.spec.forProvider.hostRule[0]);
  expect(removed.spec.deletionPolicy).toBe('Orphan');
});
test('a pre-existing hostname or matcher and a foreign project baseline cannot be adopted', () => {
  const existing = baseline(); existing.spec.forProvider.hostRule.push({ hosts: ['pixelcam.dev.apps.mooroon5.fr'], pathMatcher: 'old-owner' });
  expect(() => routing.updateMap(existing, dep)).toThrow(/belongs/);
  const matcher = baseline(); matcher.spec.forProvider.pathMatcher.push({ name: 'cnp-pixelcam-dev' });
  expect(() => routing.updateMap(matcher, dep)).toThrow(/not owned/);
  const foreign = baseline(); foreign.spec.forProvider.project = 'wrong-project';
  expect(() => routing.updateMap(foreign, dep)).toThrow(/incompatible/);
});
test('availability needs observed route, fixed service and successful HTTPS, not desired spec', async () => {
  const map = routing.updateMap(baseline(), dep);
  const n = routing.names(dep);
  const bodies = { urlmaps: ready(map.spec.forProvider),
    regionnetworkendpointgroups: ready({ cloudRun: [{ service: n.service }] }),
    backendservices: ready({ backend: [{ group: `https://www.googleapis.com/compute/v1/projects/test-project/regions/europe-west9/networkEndpointGroups/${n.neg}` }] }) };
  k8s.getComputeResource.mockImplementation(async plural => bodies[plural]);
  axios.get.mockResolvedValue({ status: 200 });
  expect(await routing.status(dep)).toBe(true);
  expect(axios.get).toHaveBeenCalledWith('https://pixelcam.dev.apps.mooroon5.fr', expect.objectContaining({ maxRedirects: 0 }));
  axios.get.mockRejectedValue(new Error('TLS pending'));
  expect(await routing.status(dep)).toBe(false);
  bodies.urlmaps.status.atProvider.hostRule = [];
  axios.get.mockClear(); expect(await routing.status(dep)).toBe(false); expect(axios.get).not.toHaveBeenCalled();
});
test('removal waits until the observed shared map no longer references the environment', async () => {
  const map = routing.updateMap(baseline(), dep);
  k8s.getComputeResource.mockResolvedValue(ready(map.spec.forProvider));
  expect(await routing.status(dep, true)).toBe(false);
  k8s.getComputeResource.mockResolvedValue(ready(baseline().spec.forProvider));
  expect(await routing.status(dep, true)).toBe(true);
});
test('sync uses current Git head atomically and only adds networking to an existing published environment', async () => {
  const documents = { [routing.ROUTING_PATH]: baseline(), 'apps/pixelcam/crossplane/dev/kustomization.yaml': { resources: ['cloudrun-claim.yaml'] } };
  const api = { request: jest.fn(async (_route, args) => ({ data: { content: Buffer.from(yaml.dump(documents[args.path])).toString('base64') } })) };
  let files;
  const commitFiles = jest.fn(async (_api, _repo, callback) => { files = await callback('latest-head'); });
  await routing.sync(dep, { api, repo: { owner: 'team', repo: 'config' }, commitFiles });
  expect(api.request.mock.calls.every(([,args]) => args.ref === 'latest-head')).toBe(true);
  expect(yaml.load(files['apps/pixelcam/crossplane/dev/kustomization.yaml']).resources).toEqual(['cloudrun-claim.yaml', 'application-network.yaml']);
  expect(files['apps/pixelcam/crossplane/dev/cloudrun-claim.yaml']).toBeUndefined();
});

// The imported map must remain update-only; unsupported combinations block all reconcile.
test('shared routing accepts only the supported Observe/Update import policy', () => {
  for (const policy of [['Observe', 'Update', 'LateInitialize'], ['*'], ['Observe', 'Create', 'Update'], ['Observe', 'Update', 'Delete']]) {
    const doc = baseline(); doc.spec.managementPolicies = policy;
    expect(() => routing.updateMap(doc, dep)).toThrow(/incompatible/);
  }
  expect(routing.updateMap(baseline(), dep).spec.managementPolicies).toEqual(['Observe', 'Update']);
});
