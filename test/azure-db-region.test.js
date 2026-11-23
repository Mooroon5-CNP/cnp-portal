'use strict';

// Serveur PostgreSQL principal hors de la région de calcul (AZURE_DB_LOCATION / AZURE_DB_RESOURCE_GROUP /
// AZURE_DB_REGION_KEY, 23/11/2026 : SkuNotAvailable en francecentral). La Container App reste en France.

const yaml = require('js-yaml');
const t = require('../src/services/azure-templates');

const revision = 'a'.repeat(40);
const base = {
  namePrefix: 'cnp-sov', regionKey: 'fr', location: 'francecentral', resourceGroup: 'cnp-sov-fr-rg', nameSuffix: '8e885538',
  acrLoginServer: 'acr.azurecr.io', environmentId: '/subscriptions/s/env', pullIdentityId: '/subscriptions/s/uami',
  dbSubnetId: '/subscriptions/s/fr-snet-data', dbDnsZoneId: '/subscriptions/s/privateDnsZones/cnp-sov.postgres.database.azure.com',
  copyRegionKey: 'it', copyLocation: 'italynorth', copyResourceGroup: 'cnp-sov-it-rg', copyDbSubnetId: '/subscriptions/s/it-snet-data',
  keyVaultId: '/subscriptions/s/vault',
};
const italy = { ...base, dbLocation: 'italynorth', dbResourceGroup: 'cnp-sov-it-rg', dbRegionKey: 'itdb', dbSubnetId: '/subscriptions/s/it-snet-data' };
const files = (azure, env) => t.azureCrossplaneFiles('todo', 8080, azure, env, revision);
const server = f => yaml.load(f['flexibleserver.yaml']);
const claim = f => yaml.load(f['containerapp-claim.yaml']).spec.forProvider;
const dbHost = f => claim(f).template.container[0].env.find(e => e.name === 'DB_HOST').value;

describe('serveur PostgreSQL principal dans sa propre région', () => {
  test('sans les nouvelles variables : sortie identique à celle des valeurs explicites de la Container App', () => {
    const explicit = { ...base, dbLocation: 'francecentral', dbResourceGroup: 'cnp-sov-fr-rg', dbRegionKey: 'fr' };
    for (const env of [undefined, 'dev', 'prod']) expect(files(base, env)).toEqual(files(explicit, env));
    const prod = files(base, 'prod');
    expect(server(prod).metadata.name).toBe('cnp-sov-fr-todo-prod-8e885538');
    expect(server(prod).spec.forProvider).toMatchObject({ location: 'francecentral', resourceGroupName: 'cnp-sov-fr-rg', delegatedSubnetId: '/subscriptions/s/fr-snet-data' });
    expect(prod['flexibleserver-copy.yaml']).toBeDefined();
    expect(yaml.load(prod['kustomization.yaml']).resources).toContain('flexibleserver-copy.yaml');
    expect(dbHost(prod)).toBe('todo-prod-db.cnp-sov.postgres.database.azure.com');
    expect(t.azureNames('todo', base).server).toBe('cnp-sov-fr-todo-dev-8e885538');
  });

  test('base en Italie : serveur principal en italynorth / cnp-sov-it-rg / sous-réseau italien, nouveau nom ; Container App en France', () => {
    for (const env of ['dev', 'prod']) {
      const f = files(italy, env);
      const s = server(f);
      expect(s.metadata.name).toBe(`cnp-sov-itdb-todo-${env}-8e885538`);
      expect(s.metadata.name).not.toBe(t.azureNames('todo', base, env).server);
      expect(s.spec.forProvider).toMatchObject({
        location: 'italynorth', resourceGroupName: 'cnp-sov-it-rg', delegatedSubnetId: '/subscriptions/s/it-snet-data',
        privateDnsZoneId: base.dbDnsZoneId,
      });
      expect(yaml.load(f['flexibleserver-database.yaml']).spec.forProvider.serverIdRef.name).toBe(s.metadata.name);
      expect(claim(f).resourceGroupName).toBe('cnp-sov-fr-rg');
      expect(claim(f).containerAppEnvironmentId).toBe('/subscriptions/s/env');
      // sans copie, aucun alias n'est tenu par le moteur : l'app parle au serveur directement
      expect(dbHost(f)).toBe(`cnp-sov-itdb-todo-${env}-8e885538.postgres.database.azure.com`);
    }
    expect(t.azureNames('todo', italy).server).toBe('cnp-sov-itdb-todo-dev-8e885538');
  });

  test('prod avec la base dans la région de copie : pas de serveur de copie, kustomization cohérente', () => {
    const prod = files(italy, 'prod');
    expect(prod['flexibleserver-copy.yaml']).toBeUndefined();
    const resources = yaml.load(prod['kustomization.yaml']).resources;
    expect(resources).not.toContain('flexibleserver-copy.yaml');
    for (const r of resources) expect(prod[r]).toBeDefined();
    expect(Object.keys(prod).filter(k => k !== 'kustomization.yaml').sort()).toEqual([...resources].sort());
    expect(prod['flexibleserver.yaml']).not.toContain('flexibleserver-copy.yaml');
    expect(prod['flexibleserver.yaml']).toContain('non copié');
    expect(t.azureNames('todo', italy, 'prod').hasCopy).toBe(false);
    expect(t.azureHasCopy(italy)).toBe(false);
  });

  test('base dans une troisième région : la copie est toujours générée', () => {
    const elsewhere = { ...italy, dbLocation: 'westeurope', dbRegionKey: 'we' };
    const prod = files(elsewhere, 'prod');
    expect(yaml.load(prod['flexibleserver-copy.yaml']).spec.forProvider.location).toBe('italynorth');
    expect(yaml.load(prod['kustomization.yaml']).resources).toContain('flexibleserver-copy.yaml');
    expect(dbHost(prod)).toBe('todo-prod-db.cnp-sov.postgres.database.azure.com');
  });

  test('les noms ne se télescopent jamais, même au nom d\'app le plus long', () => {
    const longest = 'a'.repeat(t.MAX_APP_NAME_WITH_ENV);
    for (const azure of [base, italy]) {
      for (const env of ['dev', 'prod']) {
        const n = t.azureNames(longest, azure, env);
        expect(n.server).not.toBe(n.copyServer);
        expect(n.server.length).toBeLessThanOrEqual(63);
        expect(n.server).toMatch(/^[a-z0-9-]+$/);
      }
    }
    expect(t.azureNames('a'.repeat(32), italy).server.length).toBeLessThanOrEqual(63);
    expect(t.azureNames('todo', italy, 'prod').server).not.toBe(t.azureNames('todo', base, 'prod').copyServer);
    expect(() => t.azureNames('todo', { ...italy, dbRegionKey: 'it' }, 'prod')).toThrow(/même nom/);
  });
});
