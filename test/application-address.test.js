'use strict';

jest.mock('../src/config/env', () => ({ config: { applications: {} } }));
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
