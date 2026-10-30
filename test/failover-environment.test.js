'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'Mooroon5-CNP/config-repo' } } }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn() }));
jest.mock('../src/services/environment-deployment', () => ({ commitFiles: jest.fn() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const db = require('../src/models/db');
const github = require('../src/clients/github');
const deployment = require('../src/services/environment-deployment');
const service = require('../src/services/environment-failover');
const root = path.resolve(__dirname, '../../config-repo');
const dir = 'apps/app4-pixelcam/crossplane/prod';
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-failover-test-'));
const manager = { id: 'manager-test', role: 'manager' };
let api, input;

beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_candidates');
  input = {
    profile: JSON.parse(fs.readFileSync(path.join(root, 'docs/templates/failover-phase1/pixelcalm/recipe.example.json'))),
    credentials: { aws_secret_arns: Object.fromEntries(['bootstrap', 'source-admin', 'runtime'].map(role => [role,
      `arn:aws:secretsmanager:eu-west-3:804210702561:secret:cnp/failover/app4-pixelcam/${role}-Ab1234`])),
    gcp_runtime_secret: 'projects/cnp-terraform-512313/secrets/app4-pixelcam-prod-runtime' },
    secrets: { app: 'app4-pixelcam', initialized: true, gcp_password_version: '1' }, observations: {},
  };
  input.profile.aws.database_security_group_id = 'sg-0123456789abcdef0';
  const s = { app: 'app4-pixelcam' };
  for (const key of ['profile', 'credentials', 'secrets', 'observations']) {
    s[key] = path.join(temp, `${key}.json`);
    fs.writeFileSync(s[key], JSON.stringify(input[key]));
  }
  process.env.CNP_FAILOVER_SETTINGS = path.join(temp, 'settings.json');
  fs.writeFileSync(process.env.CNP_FAILOVER_SETTINGS, JSON.stringify(s));
  api = { request: jest.fn(async (route, args) => {
    if (route.endsWith('/contents/{path}')) {
      return { data: { content: fs.readFileSync(path.join(root, args.path)).toString('base64') } };
    }
    if (route.includes('/git/ref/')) return { data: { object: { sha: base } } };
    if (route.startsWith('GET') && route.includes('/pulls/')) return { data: { state: 'open', base: { ref: 'main' }, head: { sha: head } } };
    if (route.startsWith('POST') && route.endsWith('/pulls')) return { data: { number: 123, html_url: 'https://github.com/Mooroon5-CNP/config-repo/pull/123', user: { login: 'cnp-platform-bot[bot]' } } };
    if (route.startsWith('PUT')) return { data: { merged: true, sha: 'c'.repeat(40) } };
    return { data: {} };
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
  deployment.commitFiles.mockResolvedValue(head);
});
afterAll(() => { delete process.env.CNP_FAILOVER_SETTINGS; fs.rmSync(temp, { recursive: true, force: true }); });

test('le profil ne modifie ni Azure ni dev ni une autre application', () => {
  for (const dep of [{ appName: 'app4-pixelcam', environment: 'dev' },
    { appName: 'app4-pixelcam', environment: 'prod', targetCluster: 'azure' },
    { appName: 'other', environment: 'prod' }]) expect(service.enabled(dep)).toBe(false);
});
test('un développeur ne peut pas publier par appel direct du service', async () => {
  await expect(service.prepare('databases', { id: 'dev', role: 'dev' })).rejects.toThrow('manager');
  await expect(service.approve('id', head, { id: 'dev', role: 'dev' })).rejects.toThrow('manager');
  expect(api.request).not.toHaveBeenCalled();
});
test('le rendu réel conserve le bucket et produit Cloud SQL chiffré avec le vrai nom SQL', async () => {
  const candidate = await service.prepare('databases', manager);
  const kust = yaml.load(candidate.files[`${dir}/kustomization.yaml`]);
  expect(kust.resources).toContain('gcs-bucket.yaml');
  expect(candidate.files[`${dir}/gcs-bucket.yaml`]).toContain('47538189-data');
  const instance = yaml.load(candidate.files[`${dir}/cloudsql-instance.yaml`]);
  expect(instance.spec.forProvider.settings.ipConfiguration.sslMode).toBe('ENCRYPTED_ONLY');
  expect(instance.spec.deletionPolicy).toBe('Orphan');
  const database = yaml.load(candidate.files[`${dir}/cloudsql-database.yaml`]);
  expect(database.metadata.annotations['crossplane.io/external-name']).toBe('pixelcalm');
  expect(database.spec.forProvider.name).toBeUndefined();
  expect(deployment.commitFiles.mock.calls[0][4]).toMatch(/^cnp-failover\/databases\//);
  expect(api.request.mock.calls.some(([route]) => route.startsWith('PUT'))).toBe(false);
});
test('runtime est refusé avant publication des bases', async () => {
  await expect(service.prepare('runtime', manager)).rejects.toThrow('préalable');
  expect(github.getInstallationOctokit).not.toHaveBeenCalled();
});
test('une proposition en attente ne peut pas être remplacée', async () => {
  await service.prepare('databases', manager);
  await expect(service.prepare('databases', manager)).rejects.toThrow('attend');
});
test('un SHA approuvé différent est refusé sans merge', async () => {
  const row = await service.prepare('databases', manager);
  await expect(service.approve(row.id, 'd'.repeat(40), manager)).rejects.toThrow('modifié');
  expect(api.request.mock.calls.some(([route]) => route.startsWith('PUT'))).toBe(false);
});
test('un changement de profil invalide une revue déjà préparée', async () => {
  const row = await service.prepare('databases', manager);
  const s = service.settings();
  const profile = JSON.parse(fs.readFileSync(s.profile));
  profile.gcp.database_name = 'changed'; fs.writeFileSync(s.profile, JSON.stringify(profile));
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('Profil modifié');
});
test('une baseline distante qui a avancé interdit le merge', async () => {
  const row = await service.prepare('databases', manager);
  api.request.mockImplementation(async route => route.includes('/git/ref/')
    ? { data: { object: { sha: 'e'.repeat(40) } } }
    : { data: { state: 'open', base: { ref: 'main' }, head: { sha: head } } });
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('baseline');
});
test('seul le candidat exact est mergé via le bot et ne peut pas être approuvé deux fois', async () => {
  const row = await service.prepare('databases', manager);
  expect((await service.approve(row.id, head, manager)).published).toBe(true);
  const merge = api.request.mock.calls.find(([route]) => route.startsWith('PUT'));
  expect(merge[1].sha).toBe(head);
  expect(service.rows()[0].reviewed_by).toBe(manager.id);
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('déjà');
});
test('un timeout après merge se reprend depuis la trace manager sans second merge', async () => {
  const row = await service.prepare('databases', manager);
  api.request.mockImplementation(async route => {
    if (route.startsWith('PUT')) throw new Error('timeout');
    if (route.includes('/git/ref/')) return { data: { object: { sha: base } } };
    return { data: { state: 'open', base: { ref: 'main' }, head: { sha: head } } };
  });
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('timeout');
  expect(service.rows()[0].state).toBe('approving');
  api.request.mockClear();
  api.request.mockResolvedValue({ data: { merged: true, state: 'closed', head: { sha: head },
    base: { ref: 'main' }, merged_by: { login: 'cnp-platform-bot[bot]' }, merge_commit_sha: 'c'.repeat(40) } });
  expect((await service.approve(row.id, head, manager)).published).toBe(true);
  expect(api.request.mock.calls.some(([route]) => route.startsWith('PUT'))).toBe(false);
});
test('rejeter une proposition obsolète permet une nouvelle préparation sans effacer de ressource', async () => {
  const row = await service.prepare('databases', manager);
  expect((await service.reject(row.id, manager)).rejected).toBe(true);
  expect(api.request.mock.calls.some(([route, args]) => route.startsWith('PATCH') && args.state === 'closed')).toBe(true);
  await expect(service.prepare('databases', manager)).resolves.toHaveProperty('id');
});
