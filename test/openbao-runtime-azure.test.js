'use strict';

const yaml = require('js-yaml');
const templates = require('../src/services/azure-templates');
const runtime = require('../src/services/openbao-runtime');

const azure = { namePrefix: 'cnp-sov', regionKey: 'fr', location: 'francecentral',
  subscriptionId: 'sub-1', acrLoginServer: 'acr.azurecr.io', resourceGroup: 'rg-1', nameSuffix: 'abc123',
  environmentId: '/subscriptions/sub-1/env', pullIdentityId: '/subscriptions/sub-1/shared-acr',
  dbSubnetId: '/subscriptions/sub-1/subnet', dbDnsZoneId: '/subscriptions/sub-1/dns' };
const dep = { appName: 'todo', environment: 'dev', targetCluster: 'azure' };
const identity = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/todo-dev-secrets';

function files() {
  return Object.fromEntries(Object.entries(templates.azureCrossplaneFiles('todo', 8080, azure, 'dev', 'a'.repeat(40)))
    .map(([name, content]) => [`apps/todo/crossplane/dev/${name}`, content]));
}

test('adds versioned Key Vault refs and a dedicated identity without changing DB_PASSWORD', () => {
  const input = files();
  const before = yaml.load(input['apps/todo/crossplane/dev/containerapp-claim.yaml']);
  const secretId = 'https://cnp-test.vault.azure.net/secrets/cnp-todo-dev-var-aabbccddeeff/' + 'a'.repeat(32);
  runtime.applyAzureReferences(input, dep, { identity,
    references: [{ name: 'API_KEY', secretName: 'cnp-todo-dev-var-aabbccddeeff', keyVaultSecretId: secretId }] });
  const claim = yaml.load(input['apps/todo/crossplane/dev/containerapp-claim.yaml']);
  const names = yaml.load(input['apps/todo/crossplane/dev/containerapp-secretname.yaml']);
  expect(claim.spec.forProvider.secret[0]).toEqual(before.spec.forProvider.secret[0]);
  expect(claim.spec.forProvider.secret[1]).toEqual({
    nameSecretRef: { name: names.metadata.name, namespace: 'crossplane-system', key: 'var-cnp-todo-dev-var-aabbccddeeff' },
    keyVaultSecretId: secretId, identity });
  expect(claim.spec.forProvider.identity.identityIds).toEqual([azure.pullIdentityId, identity]);
  expect(claim.spec.forProvider.template.container[0].env).toContainEqual({ name: 'API_KEY', secretName: 'cnp-todo-dev-var-aabbccddeeff' });
  expect(names.stringData['var-cnp-todo-dev-var-aabbccddeeff']).toBe('cnp-todo-dev-var-aabbccddeeff');
  expect(JSON.stringify(input)).not.toContain('private-value');
});

test('deployment without variables produces identical Azure manifests', () => {
  const input = files();
  const before = JSON.stringify(input);
  runtime.applyAzureReferences(input, dep, null);
  expect(JSON.stringify(input)).toBe(before);
});

test('rejects a custom variable that would override a runtime variable', () => {
  expect(() => runtime.applyAzureReferences(files(), dep, { identity,
    references: [{ name: 'DB_PASSWORD', secretName: 'x', keyVaultSecretId: 'x' }] })).toThrow('conflit');
});

test('GCP variables require a distinct runtime identity for each environment', () => {
  const previousProject = process.env.GCP_PROJECT;
  const previousMap = process.env.CNP_GCP_RUNTIME_IDENTITIES;
  process.env.GCP_PROJECT = 'test-project';
  process.env.CNP_GCP_RUNTIME_IDENTITIES = JSON.stringify({
    'todo/dev': 'todo-dev@test-project.iam.gserviceaccount.com',
    'todo/prod': 'todo-prod@test-project.iam.gserviceaccount.com',
  });
  try {
    expect(runtime.gcpRuntimeIdentity(dep)).toBe('todo-dev@test-project.iam.gserviceaccount.com');
    process.env.CNP_GCP_RUNTIME_IDENTITIES = JSON.stringify({
      'todo/dev': 'todo-dev@test-project.iam.gserviceaccount.com',
      'todo/prod': 'todo-dev@test-project.iam.gserviceaccount.com',
    });
    expect(() => runtime.gcpRuntimeIdentity(dep)).toThrow('dédié');
  } finally {
    if (previousProject === undefined) delete process.env.GCP_PROJECT; else process.env.GCP_PROJECT = previousProject;
    if (previousMap === undefined) delete process.env.CNP_GCP_RUNTIME_IDENTITIES; else process.env.CNP_GCP_RUNTIME_IDENTITIES = previousMap;
  }
});
