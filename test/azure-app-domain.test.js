'use strict';
// Incident du 24/11/2026 : testapp09 dev supprimée avec son nom encore lié en SNI est restée « Failed », vide, avec une
// suppression jamais terminée (CertificateInUse). Le portail détache le nom et supprime le certificat avant la suppression.
const { releaseAppDomain, hostname, certificateName } = require('../src/services/azure-app-domain');

const ENV = '/subscriptions/8e885538-8edd-4dd1-8e3c-64f1ae5ebc1e/resourceGroups/cnp-sov-fr-rg/providers/Microsoft.App/managedEnvironments/cnp-sov-fr-cae';
const dep = { appName: 'testapp09', environment: 'dev', targetCluster: 'azure' };
const host = 'testapp09-dev.eu.mooroon5.fr';
const fail = (status, code) => Object.assign(new Error('http'), { response: { status, data: { error: { code } } } });

function azure({ state = 'Succeeded', bound = true, cert = true, tags = { 'cnp-env': 'dev' }, app = true } = {}) {
  const world = { app: app && { tags, properties: { provisioningState: state, configuration: { ingress: {
    external: true, targetPort: 8080, fqdn: 'x.azurecontainerapps.io',
    customDomains: bound === null ? [] : [{ name: host, bindingType: bound ? 'SniEnabled' : 'Disabled', certificateId: 'c' }] } } } }, cert };
  const transport = { request: jest.fn(async ({ method, url, data }) => {
    if (url.includes('/containerApps/')) {
      if (method === 'GET') { if (!world.app) throw fail(404); return { data: world.app }; }
      if (method === 'PATCH') { world.patched = data; world.app.properties.configuration.ingress.customDomains = data.properties.configuration.ingress.customDomains; return { data: {} }; }
    }
    if (url.includes('/managedCertificates/') && method === 'DELETE') {
      if (!world.cert) throw fail(404);
      if (world.app?.properties?.configuration.ingress.customDomains.some(d => d.bindingType === 'SniEnabled')) throw fail(400, 'CertificateInUse');
      world.cert = false; return { data: {} };
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }) };
  return { world, transport };
}
const options = transport => ({ environmentId: ENV, domain: 'eu.mooroon5.fr', tenantId: '22222222-2222-4222-a222-222222222222',
  clientId: '33333333-3333-4333-a333-333333333333', tokenFile: '/fake', transport, accessToken: async () => 'token' });

test('names follow the replication job (azure_domains.py)', () => {
  expect(hostname('testapp09', 'dev', 'eu.mooroon5.fr')).toBe(host);
  expect(hostname('testapp09', 'prod', 'eu.mooroon5.fr')).toBe('testapp09.eu.mooroon5.fr');
  expect(certificateName(host)).toBe('cnp-testapp09-dev-eu-mooroon5-fr');
});

test('a bound name is detached first (full ingress kept), then the certificate is deleted', async () => {
  const { world, transport } = azure();
  await expect(releaseAppDomain(dep, options(transport))).resolves.toEqual({ released: false, reason: 'domain detached' });
  expect(world.patched.properties.configuration.ingress).toEqual({ external: true, targetPort: 8080, customDomains: [] });
  expect(world.cert).toBe(true);
  await expect(releaseAppDomain(dep, options(transport))).resolves.toEqual({ released: true });
  expect(world.cert).toBe(false);
  await expect(releaseAppDomain(dep, options(transport))).resolves.toEqual({ released: true });
});

test('nothing is written on a busy app; a name re-added "Disabled" by the job does not block', async () => {
  const busy = azure({ state: 'InProgress' });
  await expect(releaseAppDomain(dep, options(busy.transport))).resolves.toEqual({ released: false, reason: 'app InProgress' });
  expect(busy.transport.request.mock.calls.every(([r]) => r.method === 'GET')).toBe(true);
  const disabled = azure({ bound: false });
  await expect(releaseAppDomain(dep, options(disabled.transport))).resolves.toEqual({ released: true });
  expect(disabled.world.patched).toBeUndefined();
});

test('an absent app only needs its certificate gone; another environment\'s app is refused', async () => {
  const gone = azure({ app: false });
  await expect(releaseAppDomain(dep, options(gone.transport))).resolves.toEqual({ released: true });
  const other = azure({ tags: { 'cnp-env': 'prod' } });
  await expect(releaseAppDomain(dep, options(other.transport))).rejects.toThrow('hors du périmètre');
  await expect(releaseAppDomain(dep, { ...options(other.transport), domain: '' })).resolves.toEqual({ released: true, reason: 'no-public-domain' });
});
