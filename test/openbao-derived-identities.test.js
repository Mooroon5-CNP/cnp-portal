'use strict';

const { createHash } = require('crypto');
const runtime = require('../src/services/openbao-runtime');
const { vaultUrlFor } = require('../src/services/openbao-delivery-azure');

test('derives distinct account-scoped runtime identities without per-app JSON maps', () => {
  const keys = ['CNP_OPENBAO_DERIVED_IDENTITIES', 'CNP_GCP_RUNTIME_IDENTITIES', 'CNP_AZURE_RUNTIME_IDENTITIES',
    'CNP_AWS_RUNTIME_EXECUTION_ROLES', 'GCP_PROJECT', 'AZURE_SUBSCRIPTION_ID',
    'CNP_AZURE_RUNTIME_RESOURCE_GROUP', 'CNP_AWS_ACCOUNT_ID'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.CNP_OPENBAO_DERIVED_IDENTITIES = 'true';
    process.env.GCP_PROJECT = 'new-project-12345';
    process.env.AZURE_SUBSCRIPTION_ID = '11111111-2222-3333-4444-555555555555';
    process.env.CNP_AZURE_RUNTIME_RESOURCE_GROUP = 'cnp-shared';
    process.env.CNP_AWS_ACCOUNT_ID = '123456789012';
    const dev = { appName: 'sample-app', environment: 'dev' };
    const prod = { ...dev, environment: 'prod' };
    const devHash = createHash('sha256').update('sample-app/dev').digest('hex');
    const prodHash = createHash('sha256').update('sample-app/prod').digest('hex');
    expect(runtime.gcpRuntimeIdentity(dev)).toBe(`cnp-${devHash.slice(0, 20)}@new-project-12345.iam.gserviceaccount.com`);
    expect(runtime.gcpRuntimeIdentity(prod)).toBe(`cnp-${prodHash.slice(0, 20)}@new-project-12345.iam.gserviceaccount.com`);
    expect(runtime.azureRuntimeIdentity(dev)).toBe(`/subscriptions/${process.env.AZURE_SUBSCRIPTION_ID}/resourceGroups/cnp-shared/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cnp-${devHash.slice(0, 20)}-vars`);
    expect(vaultUrlFor(dev)).toBe(`https://cnp11111111${devHash.slice(0, 12)}.vault.azure.net`);
    expect(runtime.awsRuntimeRole(prod)).toBe(`arn:aws:iam::123456789012:role/cnp-${prodHash.slice(0, 20)}-exec`);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
