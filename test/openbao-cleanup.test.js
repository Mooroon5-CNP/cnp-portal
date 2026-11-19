'use strict';

jest.mock('../src/models/deployment_variables', () => ({ get: jest.fn() }));
jest.mock('../src/services/openbao-delivery-gcp', () => ({ GcpVariableDelivery: jest.fn(), secretId: jest.fn(() => 'cnp-sample-app-dev-var-test') }));
jest.mock('../src/services/openbao-client', () => ({ OpenBaoClient: { fromEnvironment: jest.fn() } }));

const records = require('../src/models/deployment_variables');
const { GcpVariableDelivery } = require('../src/services/openbao-delivery-gcp');
const { OpenBaoClient } = require('../src/services/openbao-client');
const { cleanup } = require('../src/services/openbao-cleanup');
const dep = { id: 'dep', appName: 'sample-app', environment: 'dev', targetCluster: 'gcp' };
let request, destroy;
const previous = { project: process.env.GCP_PROJECT, region: process.env.GCP_REGION };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GCP_PROJECT = 'new-project-12345';
  process.env.GCP_REGION = 'europe-west1';
  records.get.mockReturnValue({ ownedNames: ['OLD_KEY'], history: [
    { versions: { gcp: 1 } }, { versions: { gcp: 2 } },
  ] });
  request = jest.fn(async (_token, method) => method === 'GET'
    ? { labels: { cnp_app: 'sample-app', cnp_env: 'dev', cnp_owner: 'portal_variables' } } : {});
  GcpVariableDelivery.mockImplementation(() => ({ accessToken: jest.fn().mockResolvedValue('token'), transport: {}, request }));
  destroy = jest.fn().mockResolvedValue();
  OpenBaoClient.fromEnvironment.mockReturnValue({ destroyVersion: destroy });
});
afterAll(() => {
  if (previous.project === undefined) delete process.env.GCP_PROJECT; else process.env.GCP_PROJECT = previous.project;
  if (previous.region === undefined) delete process.env.GCP_REGION; else process.env.GCP_REGION = previous.region;
});

test('deletes only owned GCP secrets and recorded OpenBao versions without a runtime identity', async () => {
  await cleanup(dep);
  expect(GcpVariableDelivery).toHaveBeenCalledWith({ project: 'new-project-12345', region: 'europe-west1' });
  expect(request).toHaveBeenCalledWith('token', 'DELETE', '/secrets/cnp-sample-app-dev-var-test');
  expect(destroy.mock.calls.map(call => call[2])).toEqual([1, 2]);
});

test('refuses a foreign GCP secret before deleting it or OpenBao versions', async () => {
  request.mockResolvedValue({ labels: { cnp_app: 'other-app' } });
  await expect(cleanup(dep)).rejects.toThrow('hors du périmètre');
  expect(request.mock.calls.some(call => call[1] === 'DELETE')).toBe(false);
  expect(destroy).not.toHaveBeenCalled();
});

test('cloud privé : aucune copie à supprimer, seulement les versions OpenBao du domaine private', async () => {
  records.get.mockReturnValue({ ownedNames: ['API_URL'], history: [{ versions: { private: 4 } }] });
  await cleanup({ ...dep, targetCluster: 'private-aws' });
  expect(GcpVariableDelivery).not.toHaveBeenCalled();
  expect(OpenBaoClient.fromEnvironment).toHaveBeenCalledWith('private');
  expect(destroy.mock.calls.map(call => call[2])).toEqual([4]);
});
