'use strict';

const { domainsForDeployment } = require('../src/services/openbao-routing');

test.each([
  [{ environment: 'dev', targetCluster: 'gcp', persistentStorage: true }, ['gcp']],
  [{ environment: 'prod', targetCluster: 'gcp', persistentStorage: true }, ['gcp']],
  [{ environment: 'dev', targetCluster: 'gcp', database: 'postgres' }, ['gcp']],
  [{ environment: 'prod', targetCluster: 'gcp', failoverRequested: true }, ['gcp', 'aws']],
  [{ environment: 'dev', targetCluster: 'azure' }, ['azure']],
  [{ environment: 'prod', targetCluster: 'azure' }, ['azure']],
])('routes deployment %j only to %j', (deployment, expected) => {
  expect(domainsForDeployment(deployment)).toEqual(expected);
});

test.each([
  { environment: 'legacy', targetCluster: 'gcp' },
  { environment: 'prod', targetCluster: 'aws' },
  { environment: 'dev', targetCluster: 'azure', failoverRequested: true },
  { environment: 'dev', targetCluster: 'gcp', failoverRequested: true },
  { environment: 'prod', targetCluster: 'gcp', persistentStorage: true, failoverRequested: true },
])('rejects unsupported routing %j', deployment => {
  expect(() => domainsForDeployment(deployment)).toThrow();
});
