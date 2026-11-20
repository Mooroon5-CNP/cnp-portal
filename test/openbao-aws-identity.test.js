'use strict';

const { createHash } = require('crypto');
const { ensureAwsRole, roleArnFor } = require('../src/services/openbao-aws-identity');

const account = '123456789012';
const boundary = `arn:aws:iam::${account}:policy/cnp-runtime/cnp-runtime-exec-boundary`;
const dep = { appName: 'sample-app', environment: 'prod', targetCluster: 'gcp', failoverRequested: true };
const expected = `arn:aws:iam::${account}:role/cnp-runtime/cnp-${createHash('sha256').update('sample-app/prod').digest('hex').slice(0, 20)}-exec`;
const options = extra => ({ account, region: 'eu-west-3', boundary, python: 'python-test', ...extra });

test('derives the same role name as the Python provisioner', () => {
  expect(roleArnFor('sample-app', account)).toBe(expected);
  expect(roleArnFor('Bad_App', account)).toBeNull();
});

test('asks the Python provisioner and accepts only the expected role', async () => {
  const execute = jest.fn().mockResolvedValue(JSON.stringify({ role_arn: expected }));
  await expect(ensureAwsRole(dep, options({ execute }))).resolves.toBe(expected);
  const [python, args, input] = execute.mock.calls[0];
  expect(python).toBe('python-test');
  expect(args[0]).toMatch(/openbao_identity_aws\.py$/);
  expect(JSON.parse(input)).toEqual({ operation: 'ensure', app: 'sample-app', account, region: 'eu-west-3', boundary_arn: boundary });
  execute.mockResolvedValue(JSON.stringify({ role_arn: `arn:aws:iam::${account}:role/other` }));
  await expect(ensureAwsRole(dep, options({ execute }))).rejects.toThrow('hors du périmètre');
});

test('refuses non-failover deployments and a different boundary before any AWS call', async () => {
  const execute = jest.fn();
  await expect(ensureAwsRole({ ...dep, environment: 'dev' }, options({ execute }))).rejects.toThrow('invalides');
  await expect(ensureAwsRole({ ...dep, failoverRequested: false }, options({ execute }))).rejects.toThrow('invalides');
  await expect(ensureAwsRole(dep, options({ execute, boundary: `arn:aws:iam::${account}:policy/admin` }))).rejects.toThrow('invalides');
  expect(execute).not.toHaveBeenCalled();
});

test('forwards only the provisioner own messages, never raw AWS errors', async () => {
  const fail = stderr => jest.fn().mockRejectedValue(Object.assign(new Error('failed'), { stderr }));
  await expect(ensureAwsRole(dep, options({ execute: fail('Isolation du rôle AWS non prouvée.') }))).rejects.toThrow('Isolation du rôle AWS non prouvée.');
  await expect(ensureAwsRole(dep, options({ execute: fail('AccessDenied arn:aws:iam::123456789012:user/x secret') })))
    .rejects.toThrow('Provisionnement AWS indisponible ou refusé.');
});
