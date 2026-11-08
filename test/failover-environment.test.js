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
// Contenu GitOps réel du config-repo voisin, pour simuler les lectures GitHub ; les gabarits du moteur sont dans ce dépôt.
const root = path.resolve(__dirname, '../../config-repo');
const templates = path.resolve(__dirname, '../scripts/failover/engine/templates');
const APP = 'demo-api';
const dir = `apps/${APP}/crossplane/prod`;
const base = 'a'.repeat(40), head = 'b'.repeat(40);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-failover-test-'));
const manager = { id: 'manager-test', role: 'manager' };
let api, input;

beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_candidates; DROP TABLE IF EXISTS failover_profiles');
  // Profil d'une app du régime plateforme, comme createProfile le construit (schéma lu dans la base, base appdb).
  const profile = JSON.parse(fs.readFileSync(path.join(templates, 'postgres/recipe.example.json')));
  const contract = { database: 'appdb' };
  for (const side of ['gcp', 'aws']) Object.assign(profile[side], { app_name: APP, database_name: 'appdb', sql_contract: contract });
  Object.assign(profile.gcp, { gcp_lb_ip: '34.54.71.90', credentials_secret_name: `cnp-${APP}-sql`, database_instance: `${APP}-prod-gcp-db-abc` });
  profile.gcp.gcp_runtime.subnetwork = 'projects/cnp-terraform-512313/regions/europe-west9/subnetworks/gcp-subnet-1';
  Object.assign(profile.aws, { database_security_group_id: 'sg-0123456789abcdef0', listener_priority: 23456, master_password_secret: `cnp-${APP}-sql`,
    database_ca_pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' });
  profile.automation = { ...profile.automation, regime: 'platform', worker_image: '', ecs_cluster_arn: 'arn:aws:ecs:eu-west-3:804210702561:cluster/cnp-cluster',
    bootstrap_task_definition: 'cnp-failover-platform-bootstrap', worker_task_definition: 'cnp-failover-platform-worker' };
  // Références produites par initialize-secrets (régime plateforme : quatre secrets AWS et le secret runtime GCP).
  const credentials = { aws_secret_arns: Object.fromEntries(['bootstrap', 'source-admin', 'runtime', 'target-admin'].map(role => [role,
    `arn:aws:secretsmanager:eu-west-3:804210702561:secret:cnp/failover/${APP}/${role}-Ab1234`])),
    gcp_runtime_secret: `projects/cnp-terraform-512313/secrets/${APP}-prod-runtime` };
  input = { profile, credentials, secrets: { app: APP, initialized: true, gcp_password_version: '1' }, observations: {} };
  service.configure(APP, input, manager);
  api = { request: jest.fn(async (route, args) => {
    if (route.endsWith('/contents/{path}')) {
      // Fichier absent du config-repo (app neuve) : GitHub répond 404.
      if (!fs.existsSync(path.join(root, args.path))) throw Object.assign(new Error('not found'), { status: 404 });
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
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));

test('le profil ne modifie ni Azure ni dev ni une autre application', () => {
  for (const dep of [{ appName: APP, environment: 'dev' },
    { appName: APP, environment: 'prod', targetCluster: 'azure' },
    { appName: 'other', environment: 'prod' }]) expect(service.enabled(dep)).toBe(false);
});
test('un développeur ne peut pas publier par appel direct du service', async () => {
  await expect(service.prepare('databases', { id: 'dev', role: 'dev' })).rejects.toThrow('manager');
  await expect(service.approve('id', head, { id: 'dev', role: 'dev' })).rejects.toThrow('manager');
  expect(api.request).not.toHaveBeenCalled();
});
test('le rendu réel produit Cloud SQL chiffré, protégé, avec la base appdb', async () => {
  const candidate = await service.prepare('databases', manager, APP);
  const instance = yaml.load(candidate.files[`${dir}/cloudsql-instance.yaml`]);
  expect(instance.spec.forProvider.settings.ipConfiguration.sslMode).toBe('ENCRYPTED_ONLY');
  expect(instance.spec.deletionPolicy).toBe('Orphan');
  const database = yaml.load(candidate.files[`${dir}/cloudsql-database.yaml`]);
  expect(database.metadata.annotations['crossplane.io/external-name']).toBe('appdb');
  expect(JSON.stringify(candidate.files)).not.toMatch(/pixelcalm|pixelcam/);
  expect(deployment.commitFiles.mock.calls[0][4]).toMatch(/^cnp-failover\/databases\//);
  expect(api.request.mock.calls.some(([route]) => route.startsWith('PUT'))).toBe(false);
});
test('runtime est refusé avant publication des bases', async () => {
  await expect(service.prepare('runtime', manager, APP)).rejects.toThrow('préalable');
  expect(github.getInstallationOctokit).not.toHaveBeenCalled();
});
test('la rétention RDS choisie reste explicite et ne change pas celle de Cloud SQL', async () => {
  input.profile.aws.backup_retention_period = 1;
  service.configure(APP, input, manager);
  const candidate = await service.prepare('databases', manager, APP);
  const rds = yaml.load(candidate.files[`${dir}/rds-instance.yaml`]);
  const cloudsql = yaml.load(candidate.files[`${dir}/cloudsql-instance.yaml`]);
  expect(rds.spec.forProvider.backupRetentionPeriod).toBe(1);
  expect(cloudsql.spec.forProvider.settings.backupConfiguration.transactionLogRetentionDays).toBe(7);
});
test('une proposition en attente ne peut pas être remplacée', async () => {
  await service.prepare('databases', manager, APP);
  await expect(service.prepare('databases', manager, APP)).rejects.toThrow('attend');
});
test('un SHA approuvé différent est refusé sans merge', async () => {
  const row = await service.prepare('databases', manager, APP);
  await expect(service.approve(row.id, 'd'.repeat(40), manager)).rejects.toThrow('modifié');
  expect(api.request.mock.calls.some(([route]) => route.startsWith('PUT'))).toBe(false);
});
test('un changement de profil invalide une revue déjà préparée', async () => {
  const row = await service.prepare('databases', manager, APP);
  // configure() refuse de changer un profil qui a une proposition en attente : simuler un changement par une autre voie.
  const changed = JSON.parse(JSON.stringify(input)); changed.profile.gcp.container_port = 9090; changed.profile.aws.container_port = 9090;
  db.prepare('UPDATE failover_profiles SET document=? WHERE app_name=?').run(JSON.stringify(changed), APP);
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('Profil modifié');
});
test('une baseline distante qui a avancé interdit le merge', async () => {
  const row = await service.prepare('databases', manager, APP);
  api.request.mockImplementation(async route => route.includes('/git/ref/')
    ? { data: { object: { sha: 'e'.repeat(40) } } }
    : { data: { state: 'open', base: { ref: 'main' }, head: { sha: head } } });
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('baseline');
});
test('seul le candidat exact est mergé via le bot et ne peut pas être approuvé deux fois', async () => {
  const row = await service.prepare('databases', manager, APP);
  expect((await service.approve(row.id, head, manager)).published).toBe(true);
  const merge = api.request.mock.calls.find(([route]) => route.startsWith('PUT'));
  expect(merge[1].sha).toBe(head);
  expect(service.rows()[0].reviewed_by).toBe(manager.id);
  await expect(service.approve(row.id, head, manager)).rejects.toThrow('déjà');
});
test('un timeout après merge se reprend depuis la trace manager sans second merge', async () => {
  const row = await service.prepare('databases', manager, APP);
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
describe('approbation automatique', () => {
  const merged = () => api.request.mock.calls.some(([route]) => route.startsWith('PUT'));
  const tamper = (id, change) => {
    const row = db.prepare('SELECT files FROM failover_candidates WHERE id=?').get(id);
    const files = JSON.parse(row.files);
    change(files);
    db.prepare('UPDATE failover_candidates SET files=? WHERE id=?').run(JSON.stringify(files), id);
  };
  test('une publication réelle passe les contrôles et se merge par le bot', async () => {
    const row = await service.prepare('databases', manager, APP);
    expect(service.contentProblems(db.prepare('SELECT * FROM failover_candidates WHERE id=?').get(row.id))).toEqual([]);
    expect((await service.autoApprove(row.id, manager)).published).toBe(true);
    expect(service.rows()[0].reviewed_by).toBe(manager.id);
  });
  test('chaque écart de contenu refuse sans merge', async () => {
    const cases = {
      'hors du dossier': files => { files['apps/other-app/crossplane/prod/x.yaml'] = '{}'; },
      'sans deletionPolicy Orphan': files => {
        const name = Object.keys(files).find(key => key.endsWith('cloudsql-instance.yaml'));
        const value = JSON.parse(files[name]); delete value.spec.deletionPolicy; files[name] = JSON.stringify(value);
      },
      'routage modifié hors de l': files => { files['platform/application-routing/urlmap.yaml'] = '{}'; },
      'référencé mais absent': files => {
        const name = `${dir}/kustomization.yaml`;
        const value = JSON.parse(files[name]); value.resources.push('missing.yaml'); files[name] = JSON.stringify(value);
      },
    };
    for (const [expected, change] of Object.entries(cases)) {
      db.exec('DROP TABLE IF EXISTS failover_candidates');
      api.request.mockClear();
      const row = await service.prepare('databases', manager, APP);
      tamper(row.id, change);
      await expect(service.autoApprove(row.id, manager)).rejects.toThrow(expected);
      expect(merged()).toBe(false);
      expect(service.rows()[0].state).toBe('pending');
    }
  });
});
test('rejeter une proposition obsolète permet une nouvelle préparation sans effacer de ressource', async () => {
  const row = await service.prepare('databases', manager, APP);
  expect((await service.reject(row.id, manager)).rejected).toBe(true);
  expect(api.request.mock.calls.some(([route, args]) => route.startsWith('PATCH') && args.state === 'closed')).toBe(true);
  await expect(service.prepare('databases', manager, APP)).resolves.toHaveProperty('id');
});

test('deux applications conservent des propositions et prérequis indépendants', async () => {
  const app = 'second-backend';
  const document = JSON.parse(JSON.stringify(input).replaceAll(APP, app));
  document.profile.aws.listener_priority = 23457;
  service.configure(app, document, manager);
  expect(service.enabled({ appName: app, environment: 'prod', targetCluster: 'gcp' })).toBe(true);
  await service.prepare('databases', manager, APP);
  await expect(service.prepare('runtime', manager, app)).rejects.toThrow('préalable');
  const original = api.request.getMockImplementation();
  api.request.mockImplementation(async (route, args) => {
    if (route.endsWith('/contents/{path}') && args.path.startsWith(`apps/${app}/`)) {
      const err = new Error('not found'); err.status = 404; throw err;
    }
    return original(route, args);
  });
  const candidate = await service.prepare('databases', manager, app);
  expect(Object.keys(candidate.files).every(file => file.startsWith(`apps/${app}/crossplane/prod/`))).toBe(true);
  expect(service.rows(app)).toHaveLength(1);
  expect(service.rows(APP)).toHaveLength(1);
  await service.approve(candidate.id, head, manager);
  expect(Object.keys(service.manifests({ appName: app, environment: 'prod', targetCluster: 'gcp' }))
    .every(file => file.startsWith(`apps/${app}/`))).toBe(true);
});

test('un profil ou un secret appartenant à une autre application est refusé', () => {
  expect(() => service.configure('wrong-app', input, manager)).toThrow('appartenir');
  const document = JSON.parse(JSON.stringify(input));
  document.secrets.password = 'must-never-be-stored';
  expect(() => service.configure(APP, document, manager)).toThrow('expurgé');
});

test('un profil sans base n’est plus rendu : le failover exige PostgreSQL', async () => {
  // Retiré le 08/11/2026 : jamais proposé par le formulaire, jamais recetté dans le régime plateforme.
  const app = 'iot-site';
  const document = { profile: { mode: 'stateless', automation: {},
    gcp: { app_name: app, application_profile: 'stateless', environment: 'prod', container_port: 3000 },
    aws: { app_name: app, application_profile: 'stateless', environment: 'prod', container_port: 3000 } },
    credentials: {}, secrets: { app }, observations: {} };
  expect(() => service.configure(app, document, manager)).toThrow();
  expect(service.profileFor(app)).toBeNull();
});

test('la disponibilité refuse les preuves d’un ancien profil et les dates futures', () => {
  const { createHash } = require('crypto');
  service.rows();
  const operations = require('../src/services/failover-operations');
  operations.list(APP);
  db.prepare("DELETE FROM failover_operations WHERE app=?").run(APP);
  for (const stage of ['databases', 'runtime', 'dns', 'worker']) {
    db.prepare(`INSERT INTO failover_candidates (id,stage,base_sha,head_sha,pr_number,pr_url,files,input_hash,state,requested_by,created_at,app_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(stage, stage, base, head, 1, 'url', '{}', 'hash', 'published', manager.id, new Date().toISOString(), APP);
  }
  const dep = { appName: APP, environment: 'prod', targetCluster: 'gcp' };
  const currentHash = createHash('sha256').update(JSON.stringify(service.profileFor(APP))).digest('hex');
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run('health-proof', APP, 'health', 'completed', 'old-profile', manager.id,
    JSON.stringify({ verified: true, state: 'WAIT_SIGNALS', observed_at: Date.now() / 1000 }), new Date().toISOString(), null);
  expect(service.readiness(dep).phase).toBe('deploying');
  db.prepare('UPDATE failover_operations SET input_hash=? WHERE id=?').run(currentHash, 'health-proof');
  expect(service.readiness(dep).phase).toBe('success');
  db.prepare('UPDATE failover_operations SET result=? WHERE id=?').run(JSON.stringify({ verified: true, observed_at: Date.now() / 1000 + 600 }), 'health-proof');
  expect(service.readiness(dep).phase).toBe('deploying');
});
