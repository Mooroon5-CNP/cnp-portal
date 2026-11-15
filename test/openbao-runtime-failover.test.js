'use strict';

const records = require('../src/models/deployment_variables');
const variables = require('../src/services/openbao-variables');
const { GcpVariableDelivery } = require('../src/services/openbao-delivery-gcp');
const awsDelivery = require('../src/services/openbao-delivery-aws');
const runtime = require('../src/services/openbao-runtime');

const dep = { id: 'deployment-test', appName: 'sample-app', environment: 'prod', targetCluster: 'gcp', failoverRequested: true };
const sa = 'sample-app-prod@test-project.iam.gserviceaccount.com';
const profile = { gcp: { gcp_runtime: { service_account: sa } } };
const image = { aws: '123456789012.dkr.ecr.eu-west-3.amazonaws.com/sample-app@sha256:' + 'a'.repeat(64) };
const role = 'arn:aws:iam::123456789012:role/sample-app-prod-execution';
const generation = '11111111-1111-1111-1111-111111111111';
let previous;

beforeEach(() => {
  previous = Object.fromEntries(['GCP_PROJECT', 'GCP_REGION', 'CNP_GCP_RUNTIME_IDENTITIES',
    'CNP_AWS_RUNTIME_EXECUTION_ROLES', 'CNP_AWS_REGION'].map(key => [key, process.env[key]]));
  process.env.GCP_PROJECT = 'test-project';
  process.env.GCP_REGION = 'europe-west9';
  process.env.CNP_GCP_RUNTIME_IDENTITIES = JSON.stringify({ 'sample-app/prod': sa });
  process.env.CNP_AWS_RUNTIME_EXECUTION_ROLES = JSON.stringify({ 'sample-app/prod': role });
  process.env.CNP_AWS_REGION = 'eu-west-3';
  jest.spyOn(records, 'get').mockReturnValue({ generation, names: ['API_KEY'], versions: { gcp: 2, aws: 3 } });
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('delivers both cloud copies before exposing their runtime references', async () => {
  jest.spyOn(variables, 'service').mockReturnValue({ published: jest.fn().mockResolvedValue({ generation,
    values: { gcp: { API_KEY: 'private-value' }, aws: { API_KEY: 'private-value' } } }) });
  const gcpRef = [{ name: 'API_KEY', valueSource: { secretKeyRef: { secret: 'sample-secret', version: '7' } } }];
  const awsRef = [{ name: 'API_KEY', valueFrom: 'arn:aws:secretsmanager:eu-west-3:123456789012:secret:cnp/failover/sample-app/env-123456789abc-AbCd12:::' + generation }];
  const gcp = jest.spyOn(GcpVariableDelivery.prototype, 'deliver').mockResolvedValue(gcpRef);
  const aws = jest.spyOn(awsDelivery, 'deliver').mockReturnValue(awsRef);
  expect(await runtime.failoverReferences(dep, profile, image)).toEqual({ gcp: gcpRef, aws: awsRef, aws_execution_role: role });
  expect(gcp).toHaveBeenCalledWith(dep, { API_KEY: 'private-value' });
  expect(aws).toHaveBeenCalledWith(dep, generation, { API_KEY: 'private-value' });
});

test('a shared GCP profile or missing dedicated AWS role stops publication before any delivery', async () => {
  const gcp = jest.spyOn(GcpVariableDelivery.prototype, 'deliver');
  await expect(runtime.failoverReferences(dep, { gcp: { gcp_runtime: { service_account: 'shared@test-project.iam.gserviceaccount.com' } } }, image))
    .rejects.toThrow('profil failover');
  process.env.CNP_AWS_RUNTIME_EXECUTION_ROLES = '{}';
  await expect(runtime.failoverReferences(dep, profile, image)).rejects.toThrow('Rôle AWS');
  expect(gcp).not.toHaveBeenCalled();
});
