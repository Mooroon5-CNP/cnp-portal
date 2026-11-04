'use strict';
jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'Mooroon5-CNP/config-repo' } } }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn() }));
jest.mock('../src/clients/argocd', () => ({ getApplicationDetails: jest.fn() }));
const fs = require('fs');
const path = require('path');
const os = require('os');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-adoption-test-'));
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const service = require('../src/services/environment-failover');
const github = require('../src/clients/github');
const argo = require('../src/clients/argocd');
const app = 'app4-pixelcam';
const head = 'a'.repeat(40);
const manager = { id: 'reviewer', role: 'manager' };
let oldSettings, application, api;
beforeEach(() => {
  oldSettings = process.env.CNP_FAILOVER_SETTINGS;
  const settings = { app };
  for (const key of ['profile', 'credentials', 'secrets', 'observations']) {
    settings[key] = path.join(temp, key + '.json');
    fs.writeFileSync(settings[key], JSON.stringify(key === 'profile' ? { gcp: { app_name: app }, aws: { app_name: app } } : {}));
  }
  process.env.CNP_FAILOVER_SETTINGS = path.join(temp, 'settings.json');
  fs.writeFileSync(process.env.CNP_FAILOVER_SETTINGS, JSON.stringify(settings));
  db.exec('DELETE FROM deployments; DROP TABLE IF EXISTS failover_adoptions');
  application = { metadata: { name: `${app}-prod` }, spec: {
    source: { repoURL: 'https://github.com/Mooroon5-CNP/config-repo.git', targetRevision: 'main', path: `apps/${app}/crossplane/prod` },
    destination: { server: 'https://kubernetes.default.svc' } } };
  argo.getApplicationDetails.mockImplementation(async () => application);
  api = { request: jest.fn(async (route, args) => {
    if (route.includes('/git/ref/')) return { data: { object: { sha: head } } };
    if (args.path === 'apps/registry.yaml') return { data: { content: Buffer.from(JSON.stringify({ apps: [{ app_name: app, repo_url: 'https://github.com/Mooroon5-CNP/app4-pixelcalm', environments: ['prod'] }] })).toString('base64') } };
    return { data: { content: fs.readFileSync(path.resolve(__dirname, '../../config-repo', args.path)).toString('base64') } };
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
});
afterEach(() => { if (oldSettings) process.env.CNP_FAILOVER_SETTINGS = oldSettings; else delete process.env.CNP_FAILOVER_SETTINGS; });
test('un manager rattache le registre exact sans écrire dans Git ni Kubernetes', async () => {
  const result = await service.adopt(app, head, manager);
  const dep = deployments.get(result.deploymentId);
  expect(dep.githubRepoUrl).toBe('https://github.com/Mooroon5-CNP/app4-pixelcalm');
  expect(dep.environment).toBe('prod');
  expect(service.adopted(dep)).toBe(true);
  expect(api.request.mock.calls.every(([route]) => route.startsWith('GET'))).toBe(true);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deployment_releases'").get()).toBeUndefined();
});
test('une baseline différente et une Application en suppression interdisent le rattachement', async () => {
  await expect(service.adopt(app, 'b'.repeat(40), manager)).rejects.toThrow('baseline');
  application.metadata.deletionTimestamp = '2026-11-03T00:00:00Z';
  await expect(service.adopt(app, head, manager)).rejects.toThrow('suppression');
  expect(deployments.listForUser(null)).toHaveLength(0);
});

afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
