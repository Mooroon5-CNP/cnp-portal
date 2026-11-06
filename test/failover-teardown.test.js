'use strict';
// Suppression complète d'une application failover : libération des ressources, retrait, disparition, secrets, oubli.
jest.mock('../src/services/environment-failover', () => ({ enabled: jest.fn(() => true), profileFor: jest.fn() }));
jest.mock('../src/services/failover-operations', () => ({ list: jest.fn(), start: jest.fn() }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn() }));
jest.mock('../src/services/environment-deployment', () => ({ commitFiles: jest.fn(), remove: jest.fn() }));
jest.mock('../src/models/deployment', () => ({ get: jest.fn(), delete: jest.fn() }));
jest.mock('../src/models/deletion_request', () => ({ deleteByDeployment: jest.fn() }));
// Le vrai retrait de route est testé avec le routage partagé ; ici, on vérifie qu'il est demandé pour cette app, en prod.
jest.mock('../src/services/application-routing', () => ({ ROUTING_PATH: 'platform/application-routing/urlmap.yaml',
  updateMap: jest.fn((map, dep, remove) => ({ ...map, removedFor: remove && `${dep.appName}-${dep.environment}` })) }));
const yaml = require('js-yaml');
const db = require('../src/models/db');
const operations = require('../src/services/failover-operations');
const github = require('../src/clients/github');
const deployment = require('../src/services/environment-deployment');
const deployments = require('../src/models/deployment');
const teardown = require('../src/services/failover-teardown');

const dep = { id: 'dep-1', appName: 'weather-api', environment: 'prod' };
const user = { id: 'manager', role: 'manager' };
const sql = { apiVersion: 'sql.gcp.upbound.io/v1beta2', kind: 'DatabaseInstance', metadata: { name: 'weather-api-prod-gcp-db' },
  spec: { deletionPolicy: 'Orphan', forProvider: { deletionProtection: true, settings: { tier: 'db-f1-micro', deletionProtectionEnabled: true } } } };
const rds = { apiVersion: 'rds.aws.upbound.io/v1beta2', kind: 'Instance', metadata: { name: 'weather-api-prod-db' },
  spec: { deletionPolicy: 'Orphan', forProvider: { deletionProtection: true, skipFinalSnapshot: false } } };
const bucket = { apiVersion: 'storage.gcp.upbound.io/v1beta1', kind: 'Bucket', metadata: { name: 'historic' },
  spec: { deletionPolicy: 'Orphan', managementPolicies: ['Observe'], forProvider: {} } };
let tasks, commits;

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-11-06T16:00:00Z'));
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_teardown');
  tasks = []; commits = [];
  operations.list.mockImplementation(() => tasks.slice().reverse());
  operations.start.mockImplementation((app, action) => { const row = { id: `op-${tasks.length + 1}`, action, state: 'running' }; tasks.push(row); return row; });
  const files = { 'apps/weather-api/crossplane/prod/kustomization.yaml': yaml.dump({ kind: 'Kustomization', resources: ['sql.yaml', 'rds.yaml'] }),
    'apps/weather-api/crossplane/prod/sql.yaml': JSON.stringify(sql), 'apps/weather-api/crossplane/prod/rds.yaml': JSON.stringify(rds),
    'platform/application-routing/urlmap.yaml': yaml.dump({ kind: 'URLMap' }) };
  github.getInstallationOctokit.mockResolvedValue({ request: jest.fn(async (route, args) => {
    if (!(args.path in files)) throw Object.assign(new Error('absent'), { status: 404 });
    return { data: { content: Buffer.from(files[args.path]).toString('base64') } };
  }) });
  deployment.commitFiles.mockImplementation(async (api, repo, build, message) => { commits.push({ message, files: await build('head') }); return 'sha'; });
  deployments.get.mockReturnValue(dep);
});
afterEach(() => jest.useRealTimers());
const succeed = (result = { verified: true }) => Object.assign(tasks.at(-1), { state: 'completed', result });
const step = async () => { jest.setSystemTime(Date.now() + 30000); await teardown.advance('weather-api'); return teardown.get('weather-api'); };

test('la libération passe tout en Delete, lève la protection des bases, sans snapshot, et épargne ce qui est en observation seule', () => {
  const freed = teardown.release(sql);
  expect(freed.spec.deletionPolicy).toBe('Delete');
  expect(freed.spec.forProvider.deletionProtection).toBe(false);
  expect(freed.spec.forProvider.settings).toEqual({ tier: 'db-f1-micro', deletionProtectionEnabled: false });
  expect(teardown.release(rds).spec.forProvider).toEqual({ deletionProtection: false, skipFinalSnapshot: true, deleteAutomatedBackups: true });
  expect(teardown.release(bucket).spec.deletionPolicy).toBe('Orphan');
  // Créé par Crossplane sans droit de suppression (verrou DNS) : la suppression de l'app le lui rend.
  const latch = { kind: 'HealthCheck', spec: { deletionPolicy: 'Orphan', managementPolicies: ['Observe', 'Create', 'Update'], forProvider: {} } };
  expect(teardown.release(latch).spec).toMatchObject({ deletionPolicy: 'Delete', managementPolicies: ['Observe', 'Create', 'Update', 'Delete'] });
  const list = teardown.release({ kind: 'List', items: [sql, bucket] });
  expect(list.items.map(item => item.spec.deletionPolicy)).toEqual(['Delete', 'Orphan']);
  expect(sql.spec.deletionPolicy).toBe('Orphan');                      // l'original n'est pas modifié
});

test('le parcours complet libère, retire, attend la disparition, nettoie puis oublie l’application', async () => {
  teardown.start(dep, user);
  let row = await step();                                                // libération publiée
  expect(commits[0].message).toContain('release');
  expect(JSON.parse(commits[0].files['apps/weather-api/crossplane/prod/sql.yaml']).spec.deletionPolicy).toBe('Delete');
  row = await step(); expect(tasks.at(-1).action).toBe('teardown-released');
  succeed({ verified: false, message: 'En attente de la libération de : weather-api-prod-db' });
  row = await step(); expect(row.state).toBe('waiting'); expect(row.message).toContain('weather-api-prod-db');
  succeed(); row = await step(); expect(row.step).toBe(2);
  row = await step();                                                    // retrait publié
  const removed = commits[1].files;
  expect(removed['apps/weather-api/crossplane/prod/sql.yaml']).toBeNull();
  expect(yaml.load(removed['apps/weather-api/crossplane/prod/kustomization.yaml']).resources).toEqual([]);
  expect(yaml.load(removed['platform/application-routing/urlmap.yaml']).removedFor).toBe('weather-api-prod');
  row = await step(); expect(tasks.at(-1).action).toBe('teardown-gone'); succeed();
  row = await step(); row = await step(); expect(tasks.at(-1).action).toBe('teardown-cleanup'); succeed();
  row = await step(); row = await step();                               // oubli
  expect(deployment.remove).toHaveBeenCalledWith(dep, { afterFailoverTeardown: true });
  expect(deployments.delete).toHaveBeenCalledWith('dep-1');
  expect(teardown.get('weather-api').state).toBe('completed');            // et ne se relance pas
  await step(); expect(deployment.remove).toHaveBeenCalledTimes(1);
});

test('une attente trop longue bloque avec ce qui reste, sans rien supprimer de plus', async () => {
  teardown.start(dep, user);
  db.prepare('UPDATE failover_teardown SET step=3 WHERE app=?').run('weather-api');
  await step(); succeed({ verified: false, message: 'En attente de la destruction de 1 ressource(s).' });
  jest.setSystemTime(Date.now() + 3700000);
  const row = await step();
  expect(row.state).toBe('blocked');
  expect(row.message).toContain('1 ressource');
  expect(deployments.delete).not.toHaveBeenCalled();
});

test('rien n’est lancé pour une application sans failover', () => {
  require('../src/services/environment-failover').enabled.mockReturnValueOnce(false);
  expect(() => teardown.start(dep, user)).toThrow('Aucun failover');
});
