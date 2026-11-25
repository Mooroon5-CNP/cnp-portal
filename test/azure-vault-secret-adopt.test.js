'use strict';
// Incident testapp09 prod (25/11/2026) : le secret Key Vault d'une app recréée restait en « already exists » et la
// Container App n'était jamais créée. Le portail le fait adopter, seulement dans le coffre et sous le nom attendus.
const { vaultSecretToAdopt } = require('../src/clients/kubernetes');

const VAULT = 'cnpsovkv8e885538';
const name = 'testapp09-prod-pg-password';
const version = '759e9e46ba50455abcbec156fb4e64a3';
const message = (vault = VAULT, secret = name) => `create failed: async create failed: failed to create the resource: [{0 A resource with the ID "https://${vault}.vault.azure.net/secrets/${secret}/${version}" already exists - to be managed via Terraform this resource needs to be imported into the State.  []}]`;
const body = (overrides = {}) => ({
  metadata: { name, annotations: {}, ...overrides.metadata },
  spec: { forProvider: { name, keyVaultId: `/subscriptions/x/resourceGroups/cnp-sov-shared-rg/providers/Microsoft.KeyVault/vaults/${VAULT}`, ...overrides.forProvider } },
  status: { conditions: [{ type: 'Ready', status: 'False', reason: 'Creating' },
    { type: 'Synced', status: 'False', reason: 'ReconcileError', message: overrides.message ?? message() }] },
});

test('the real incident message gives the external name Crossplane itself uses (<name>/<version>)', () => {
  expect(vaultSecretToAdopt(body(), name, VAULT)).toBe(`${name}/${version}`);
});

test('nothing is adopted outside the expected vault, under another name, or when already managed', () => {
  expect(vaultSecretToAdopt(body({ message: message('othervault') }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(body({ message: message(VAULT, 'other-app-prod-pg-password') }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(body({ forProvider: { keyVaultId: '/subscriptions/x/providers/Microsoft.KeyVault/vaults/othervault' } }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(body({ forProvider: { name: 'renamed' } }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(body({ metadata: { annotations: { 'crossplane.io/external-name': `${name}/abc` } } }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(body({ metadata: { deletionTimestamp: '2026-11-25T12:00:00Z' } }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(body({ message: 'some other error' }), name, VAULT)).toBeNull();
  expect(vaultSecretToAdopt(undefined, name, VAULT)).toBeNull();
});
