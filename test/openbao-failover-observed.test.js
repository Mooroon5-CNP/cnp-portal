'use strict';

const { expected } = require('../src/services/openbao-failover-observed');

const app = 'sample-app';
const prefix = `apps/${app}/crossplane/prod/`;
const files = {
  [`${prefix}cloudrun-claim.yaml`]: JSON.stringify({ spec: { forProvider: { template: { containers: [{ env: [
    { name: 'FEATURE', valueSource: { secretKeyRef: { secret: 'cnp-feature', version: '7' } } },
  ] }] } } } }),
  [`${prefix}ecs-task-definition.yaml`]: JSON.stringify({ spec: { forProvider: { containerDefinitions: JSON.stringify([
    { secrets: [{ name: 'FEATURE', valueFrom: 'arn:aws:secretsmanager:eu-west-3:123456789012:secret:feature-AbCd12:::version' }] },
  ]) } } }),
};

test('extracts pinned references from the published candidate for both runtimes', () => {
  const result = expected(files, app, ['FEATURE'], ['FEATURE', 'OLD']);
  expect(result.gcp[0].valueSource.secretKeyRef.version).toBe('7');
  expect(result.aws[0].valueFrom).toContain(':::version');
  expect(result.ownedNames).toEqual(['FEATURE', 'OLD']);
});

test('refuses a published runtime missing a variable on either cloud', () => {
  expect(() => expected(files, app, ['FEATURE', 'MISSING'], ['FEATURE', 'MISSING'])).toThrow('incomplètes');
});
