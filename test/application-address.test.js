'use strict';

jest.mock('../src/config/env', () => ({ config: { applications: {} } }));
jest.mock('../src/services/environment-failover', () => ({ enabled: jest.fn(() => false) }));
const failover = require('../src/services/environment-failover');
const { config } = require('../src/config/env');
const address = require('../src/services/application-address');

beforeEach(() => { config.applications = {}; });

test('dev and production use distinct public hostnames independent of Cloud Run names', () => {
    expect(address.url({ appName: 'pixelcalm', environment: 'dev', resourceName: 'pixelcalm-dev' })).toBe('https://pixelcalm.dev.apps.mooroon5.fr');
    expect(address.url({ appName: 'pixelcalm', environment: 'prod', resourceName: 'pixelcalm-prod' })).toBe('https://pixelcalm.apps.mooroon5.fr');
    expect(address.url({ appName: 'cnp-portal', environment: 'legacy' })).toBeNull();
});

test('a configured applications domain is normalized separately from cluster ingress', () => {
    config.applications.baseDomain = ' Apps.Example.org. ';
    config.cluster = { baseDomain: 'cluster.example.net' };
    expect(address.url({ appName: 'pixelcalm', environment: 'dev' })).toBe('https://pixelcalm.dev.apps.example.org');
});

test.each(['https://apps.example.org', 'apps.example.org/path', '*.example.org', '-apps.example.org', 'example..org'])('rejects unsafe hostname configuration %s', domain => {
    config.applications.baseDomain = domain;
    expect(() => address.url({ appName: 'pixelcalm', environment: 'prod' })).toThrow('Domaine applicatif invalide');
});


test.each([
    [{ targetCluster: 'gcp', environment: 'dev', persistentStorage: true }, true],
    [{ targetCluster: 'gcp', environment: 'prod' }, true],
    [{ targetCluster: 'gcp', environment: 'legacy' }, false],
    [{ targetCluster: 'gcp', environment: 'dev', database: 'postgres' }, false],
    [{ targetCluster: 'gcp', environment: 'prod', failoverRequested: true }, false],
    [{ targetCluster: 'azure', environment: 'dev' }, false],
    [{ targetCluster: 'aws', environment: 'dev' }, false],
])('native access scope %j => %s', (dep, expected) => {
    expect(address.usesNativeCloudRun(dep)).toBe(expected);
});

test('an existing failover profile keeps its custom address even without a request flag', () => {
    failover.enabled.mockReturnValueOnce(true);
    expect(address.usesNativeCloudRun({ targetCluster: 'gcp', environment: 'prod' })).toBe(false);
});
