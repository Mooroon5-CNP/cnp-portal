'use strict';

jest.mock('../src/models/deployment_variables', () => ({ get: jest.fn() }));
jest.mock('../src/services/openbao-delivery-gcp', () => ({ GcpVariableDelivery: jest.fn(), secretId: jest.fn(() => 'cnp-sample-app-dev-var-test') }));
jest.mock('../src/services/openbao-client', () => ({ OpenBaoClient: { fromEnvironment: jest.fn() } }));
jest.mock('../src/services/openbao-runtime-provisioner-client', () => ({ remove: jest.fn().mockResolvedValue(null) }));

const records = require('../src/models/deployment_variables');
const { GcpVariableDelivery } = require('../src/services/openbao-delivery-gcp');
const { OpenBaoClient } = require('../src/services/openbao-client');
const { cleanup } = require('../src/services/openbao-cleanup');
const provisioner = require('../src/services/openbao-runtime-provisioner-client');
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

test('GCP et Azure : les identités runtime sont retirées, même sans variable enregistrée ; jamais en cloud privé', async () => {
  records.get.mockReturnValue(null);
  await cleanup(dep);
  expect(provisioner.remove).toHaveBeenCalledWith(dep);
  provisioner.remove.mockClear();
  await cleanup({ ...dep, targetCluster: 'private-aws' });
  expect(provisioner.remove).not.toHaveBeenCalled();
  // Azure (incident du 24/11/2026 : identité et coffre orphelins après suppression) : coffre et identité de l'app retirés.
  await cleanup({ ...dep, targetCluster: 'azure' });
  expect(provisioner.remove).toHaveBeenCalledWith({ ...dep, targetCluster: 'azure' });
});

test('une suppression d\'identité refusée arrête le nettoyage avant OpenBao', async () => {
  provisioner.remove.mockRejectedValueOnce(new Error('Compte GCP runtime existant hors du périmètre attendu.'));
  await expect(cleanup(dep)).rejects.toThrow('hors du périmètre');
  expect(destroy).not.toHaveBeenCalled();
});
