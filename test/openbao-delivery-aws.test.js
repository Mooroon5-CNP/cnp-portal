'use strict';

const { deliver } = require('../src/services/openbao-delivery-aws');

test('sends values only through stdin and returns a pinned ECS secret reference', () => {
  const dep = { appName: 'sample-app', environment: 'prod', targetCluster: 'gcp', failoverRequested: true };
  const generation = '11111111-1111-1111-1111-111111111111';
  const valueFrom = `arn:aws:secretsmanager:eu-west-3:123456789012:secret:cnp/failover/sample-app/env-${'a'.repeat(12)}-AbCd12:::${generation}`;
  const execute = jest.fn().mockReturnValue(JSON.stringify([{ name: 'API_KEY', valueFrom }]));
  expect(deliver(dep, generation, { API_KEY: 'private-value' }, { region: 'eu-west-3', execute }))
    .toEqual([{ name: 'API_KEY', valueFrom }]);
  const [python, args, options] = execute.mock.calls[0];
  expect(python).toBeTruthy();
  expect(args.join(' ')).not.toContain('private-value');
  expect(options.input).toContain('private-value');
  expect(JSON.stringify(deliver(dep, generation, { API_KEY: 'private-value' }, { region: 'eu-west-3', execute })))
    .not.toContain('private-value');
});

test('rejects an AWS delivery outside GCP PostgreSQL production with failover', () => {
  const execute = jest.fn();
  expect(() => deliver({ appName: 'sample-app', environment: 'dev', targetCluster: 'gcp' },
    '11111111-1111-1111-1111-111111111111', { API_KEY: 'private-value' }, { region: 'eu-west-3', execute }))
    .toThrow('Configuration AWS');
  expect(execute).not.toHaveBeenCalled();
});
