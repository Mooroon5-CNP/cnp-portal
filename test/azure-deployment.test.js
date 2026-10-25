'use strict';

const yaml = require('js-yaml');

jest.mock('../src/clients/github', () => ({
  checkActionsEnabled: jest.fn().mockResolvedValue(true),
  getFileSha: jest.fn().mockResolvedValue(null),
  createOrUpdateFile: jest.fn().mockResolvedValue({}),
  setRepoSecret: jest.fn().mockResolvedValue({}),
  setRepoVariable: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/services/github', () => ({
  ...jest.requireActual('../src/services/github'),
  getFileSha: jest.fn().mockResolvedValue(null),
  getFileContent: jest.fn().mockResolvedValue(null),
  createOrUpdateFileWithToken: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/clients/kubernetes', () => ({ applyApplicationSet: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/clients/argocd', () => ({}));

const { config, getMissingAzureVars } = require('../src/config/env');
const githubClient = require('../src/clients/github');
const githubService = require('../src/services/github');
const t = require('../src/services/azure-templates');
const { onboardApp } = require('../src/services/onboarding');

const AZURE = {
  namePrefix: 'cnp-sov', regionKey: 'fr', location: 'francecentral',
  subscriptionId: 'sub-1', tenantId: 'tenant-1', ciClientId: 'client-1',
  acrLoginServer: 'acr.azurecr.io', resourceGroup: 'rg-1', nameSuffix: 'abc123',
  environmentId: '/subscriptions/sub-1/env', environmentDomain: 'env.francecentral.azurecontainerapps.io',
  pullIdentityId: '/subscriptions/sub-1/uami', dbSubnetId: '/subscriptions/sub-1/subnet', dbDnsZoneId: '/subscriptions/sub-1/dns',
};

describe('azure-templates', () => {
  test('les noms invalides sont refusés', () => {
    for (const bad of ['', 'A', 'a', '1app', 'app_x', 'app--x', 'app-', 'a'.repeat(33)]) {
      expect(() => t.validateAzureAppName(bad)).toThrow();
    }
    for (const ok of ['ab', 'todo-list', 'app4-pixelcam']) {
      expect(() => t.validateAzureAppName(ok)).not.toThrow();
    }
  });

  test('un nom de serveur PostgreSQL trop long est refusé', () => {
    expect(() => t.azureNames('a'.repeat(32), { ...AZURE, nameSuffix: 'x'.repeat(30) })).toThrow('trop long');
  });

  test('tous les fichiers sont du YAML valide et cohérents entre eux', () => {
    const files = t.azureCrossplaneFiles('todo', 8080, AZURE);
    expect(Object.keys(files).sort()).toEqual([
      'containerapp-claim.yaml', 'containerapp-secretname.yaml', 'flexibleserver-database.yaml',
      'flexibleserver.yaml', 'kustomization.yaml',
    ]);
    const docs = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, yaml.load(v)]));
    const server = docs['flexibleserver.yaml'];
    const app = docs['containerapp-claim.yaml'];
    const n = t.azureNames('todo', AZURE);

    expect(server.metadata.name).toBe('cnp-sov-fr-todo-dev-abc123');
    expect(server.spec.forProvider.administratorPasswordSecretRef.name).toBe(n.passwordSecret);
    expect(docs['flexibleserver-database.yaml'].spec.forProvider.serverIdRef.name).toBe(server.metadata.name);
    const container = app.spec.forProvider.template.container[0];
    // image de départ publique : jamais une image de l'ACR qui n'existe pas encore (voir azure-templates.js)
    expect(container.image).toBe('mcr.microsoft.com/k8se/quickstart:latest');
    expect(container.env.find(e => e.name === 'DB_HOST').value).toBe(`${server.metadata.name}.postgres.database.azure.com`);
    expect(container.env.find(e => e.name === 'DB_PASSWORD').secretName).toBe('db-password');
    expect(app.spec.forProvider.secret[0].valueSecretRef.name).toBe(n.passwordSecret);
    expect(app.spec.forProvider.ingress.targetPort).toBe(8080);
    // chaque fichier référencé par la kustomization existe
    for (const r of docs['kustomization.yaml'].resources) expect(files[r]).toBeDefined();
    // l'offboarding supprime exactement ces fichiers
    expect(t.azureConfigRepoPaths('todo').sort())
      .toEqual(Object.keys(files).map(f => `apps/todo/crossplane/${f}`).sort());
  });

  test('aucune valeur n\'est interprétée comme du YAML ou du texte injecté', () => {
    expect(() => t.azureCrossplaneFiles('todo', '8080\nevil: 1', AZURE)).not.toThrow();
    const app = yaml.load(t.tplAzureContainerApp('todo', '8080\nevil: 1', AZURE));
    expect(app.spec.forProvider.ingress.targetPort).toBe(8080);
  });

  test('le workflow CI appelle pipeline-azure.yml et se parse', () => {
    const wf = yaml.load(t.tplAzureCiWorkflow('todo', 3000, 'https://github.com/Mooroon5-CNP/config-repo'));
    expect(wf.jobs.pipeline.uses).toContain('pipeline-azure.yml@main');
    expect(wf.jobs.pipeline.with.app_port).toBe('3000');
    expect(wf.jobs.pipeline.secrets.CONFIG_REPO_TOKEN).toBe('${{ secrets.CONFIG_REPO_TOKEN }}');
  });

  test('URL de l\'app', () => {
    expect(t.azureAppUrl('todo', AZURE)).toBe('https://todo.env.francecentral.azurecontainerapps.io');
    expect(t.azureAppUrl('todo', { ...AZURE, environmentDomain: undefined })).toBeNull();
  });
});

describe('onboarding Azure', () => {
  const saved = { ...config.azure };
  const savedToken = config.github.configRepoToken;
  beforeEach(() => {
    jest.clearAllMocks();
    config.github.configRepoToken = 'test-token';
    Object.assign(config.azure, AZURE);
  });
  afterAll(() => { Object.assign(config.azure, saved); config.github.configRepoToken = savedToken; });

  const run = (updateStatus, overrides = {}) => onboardApp({
    appName: 'todo', githubRepoUrl: 'https://github.com/Mooroon5-CNP/todo', appPort: 8080,
    targetCluster: 'azure', updateStatus, ...overrides,
  });

  test('config Azure absente : échec explicite, rien n\'est écrit', async () => {
    config.azure.dbDnsZoneId = '';
    const updateStatus = jest.fn();
    await run(updateStatus);
    expect(updateStatus).toHaveBeenCalledTimes(1);
    expect(updateStatus.mock.calls[0][0]).toBe('failed');
    expect(updateStatus.mock.calls[0][1]).toContain('AZURE_DB_DNS_ZONE_ID');
    expect(githubService.createOrUpdateFileWithToken).not.toHaveBeenCalled();
    expect(getMissingAzureVars(config.azure)).toEqual(['AZURE_DB_DNS_ZONE_ID']);
  });

  test('nom invalide : échec avant toute écriture', async () => {
    const updateStatus = jest.fn();
    await run(updateStatus, { appName: 'Bad_Name' });
    expect(updateStatus.mock.calls[0][0]).toBe('failed');
    expect(githubService.createOrUpdateFileWithToken).not.toHaveBeenCalled();
    expect(githubClient.setRepoSecret).not.toHaveBeenCalled();
  });

  test('succès : claims à plat, registry, ci.yml, secret, variables, commit de déclenchement', async () => {
    const updateStatus = jest.fn();
    await run(updateStatus);
    expect(updateStatus).toHaveBeenCalledWith('ready', null);

    const written = githubService.createOrUpdateFileWithToken.mock.calls.map(c => c[2]);
    expect(written).toEqual(expect.arrayContaining([
      'apps/todo/crossplane/containerapp-claim.yaml',
      'apps/todo/crossplane/flexibleserver.yaml',
      'apps/todo/crossplane/kustomization.yaml',
      'apps/registry.yaml',
    ]));
    // pas de base/overlays Kubernetes pour Azure
    expect(written.some(p => p.includes('/base/') || p.includes('/overlays/'))).toBe(false);

    expect(githubClient.setRepoSecret).toHaveBeenCalledWith('Mooroon5-CNP', 'todo', 'CONFIG_REPO_TOKEN', 'test-token');
    const vars = githubClient.setRepoVariable.mock.calls.map(c => c[2]).sort();
    expect(vars).toEqual(['AZURE_ACR_LOGIN_SERVER', 'AZURE_CLIENT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_TENANT_ID']);

    const ciPaths = githubClient.createOrUpdateFile.mock.calls.map(c => c[2]);
    expect(ciPaths).toEqual(['.github/workflows/ci.yml', '.cnp-platform']);
    expect(githubClient.createOrUpdateFile.mock.calls[0][4]).toContain('[ci skip]');
  });

  test('échec de pose d\'une variable : statut failed, pas de commit de déclenchement', async () => {
    githubClient.setRepoVariable.mockRejectedValueOnce(new Error('403'));
    const updateStatus = jest.fn();
    await run(updateStatus);
    expect(updateStatus.mock.calls[0][0]).toBe('failed');
    expect(updateStatus.mock.calls[0][1]).toContain('AZURE_');
    expect(githubClient.createOrUpdateFile.mock.calls.map(c => c[2])).not.toContain('.cnp-platform');
  });
});
