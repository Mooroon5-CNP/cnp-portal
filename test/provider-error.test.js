const { safeDetails, provisionError } = require('../scripts/runtime/provider-error.cjs');
test('only known error metadata survives; provider messages, credentials and payload never do', () => {
  const original = { code: 'ETIMEDOUT', message: 'private-token', config: { headers: { Authorization: 'private-token' } }, response: { status: 403, data: { error: { status: 'PERMISSION_DENIED', message: 'private-payload', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', metadata: { service: 'iam.googleapis.com', token: 'private-token', permission: 'iam.serviceAccounts.create' } }] } } } };
  const error = provisionError('iam.serviceAccounts.create', original, 'Identity provisioning failed.');
  expect(error).toMatchObject({ status: 403, operation: 'iam.serviceAccounts.create', reason: 'SERVICE_DISABLED', service: 'iam.googleapis.com', permission: 'iam.serviceAccounts.create', networkCode: 'ETIMEDOUT' });
  expect(JSON.stringify(error)).not.toContain('private');
});
test('unknown reason/status values and malformed permissions are not displayed', () => {
  expect(safeDetails({ status: 'private', providerStatus: 'private-payload', reason: 'private-secret', permission: 'private-secret', networkCode: 'private-secret' })).toEqual({});
});
