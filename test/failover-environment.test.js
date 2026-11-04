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
  db.exec('DROP TABLE IF EXISTS failover_candidates; DROP TABLE IF EXISTS failover_profiles; DROP TABLE IF EXISTS failover_adoptions');
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
  const bucketFile = yaml.load(candidate.files[`${dir}/gcs-bucket.yaml`]);
  const bucket = bucketFile.kind === 'List' ? bucketFile.items.find(item => item.kind === 'Bucket') : bucketFile;
  expect(bucket.spec.deletionPolicy).toBe('Orphan');
  expect(bucket.spec.managementPolicies).toEqual(['Observe']);
  expect(bucket.spec.forProvider.forceDestroy).toBe(false);
  expect(bucket.metadata.annotations['crossplane.io/external-name']).toBe(bucket.metadata.name);
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
test('la rétention RDS choisie reste explicite et ne change pas celle de Cloud SQL', async () => {
  input.profile.aws.backup_retention_period = 1;
  const s = service.settings();
  fs.writeFileSync(s.profile, JSON.stringify(input.profile));
  const candidate = await service.prepare('protection', manager);
  const rds = yaml.load(candidate.files[`${dir}/rds-instance.yaml`]);
  const cloudsql = yaml.load(candidate.files[`${dir}/cloudsql-instance.yaml`]);
  expect(rds.spec.forProvider.backupRetentionPeriod).toBe(1);
  expect(cloudsql.spec.forProvider.settings.backupConfiguration.transactionLogRetentionDays).toBe(7);
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

test('deux applications conservent des propositions et prérequis indépendants', async () => {
  const app = 'second-backend';
  const document = JSON.parse(JSON.stringify(input).replaceAll('app4-pixelcam', app));
  document.profile.gcp.credentials_secret_name = 'cnp-second-sql';
  service.configure(app, document, manager);
  expect(service.enabled({ appName: app, environment: 'prod', targetCluster: 'gcp' })).toBe(true);
  await service.prepare('databases', manager, 'app4-pixelcam');
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
  expect(service.rows('app4-pixelcam')).toHaveLength(1);
  await service.approve(candidate.id, head, manager);
  expect(Object.keys(service.manifests({ appName: app, environment: 'prod', targetCluster: 'gcp' }))
    .every(file => file.startsWith(`apps/${app}/`))).toBe(true);
});

test('un profil ou un secret appartenant à une autre application est refusé', () => {
  expect(() => service.configure('wrong-app', input, manager)).toThrow('appartenir');
  const document = JSON.parse(JSON.stringify(input));
  document.secrets.password = 'must-never-be-stored';
  expect(() => service.configure('app4-pixelcam', document, manager)).toThrow('expurgé');
});

test('le contrat générique produit des bases dédiées sans nom ou schéma Pixelcalm', async () => {
  const app = 'telemetry-api';
  const document = JSON.parse(JSON.stringify(input).replaceAll('app4-pixelcam', app));
  document.profile.gcp.credentials_secret_name = 'cnp-telemetry-sql';
  const contract = { database: 'telemetry', tables: [{ name: 'measurements', columns: [
    { name: 'id', type: 'bigint', primary_key: true, identity: true }, { name: 'value', type: 'numeric' },
  ] }] };
  for (const side of ['gcp', 'aws']) Object.assign(document.profile[side], {
    application_profile: 'postgres', database_name: 'telemetry', sql_contract: contract,
  });
  service.configure(app, document, manager);
  const original = api.request.getMockImplementation();
  api.request.mockImplementation(async (route, args) => {
    if (route.endsWith('/contents/{path}') && args.path.startsWith(`apps/${app}/`)) {
      const err = new Error('not found'); err.status = 404; throw err;
    }
    return original(route, args);
  });
  const candidate = await service.prepare('databases', manager, app);
  const sql = yaml.load(candidate.files[`apps/${app}/crossplane/prod/cloudsql-database.yaml`]);
  expect(sql.metadata.annotations['crossplane.io/external-name']).toBe('telemetry');
  expect(JSON.stringify(candidate.files)).not.toContain('pixelcalm');
});

test('un site sans base génère les deux runtimes et un DNS sans base ni verrou SQL', async () => {
  const app = 'iot-site';
  const document = { profile: { mode: 'stateless', automation: {},
    gcp: { app_name: app, application_profile: 'stateless', environment: 'prod', container_port: 3000,
      gcp_lb_ip: '34.54.71.90', gcp_runtime: { image: `europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/${app}@sha256:${'a'.repeat(64)}`,
        service_account: 'cloud-run-sa@cnp-terraform-512313.iam.gserviceaccount.com', subnetwork: 'projects/cnp-terraform-512313/regions/europe-west9/subnetworks/gcp-hybrid-subnet' } },
    aws: { app_name: app, application_profile: 'stateless', environment: 'prod', container_port: 3000,
      image: `804210702561.dkr.ecr.eu-west-3.amazonaws.com/${app}@sha256:${'a'.repeat(64)}`, listener_priority: 23456 } },
    credentials: {}, secrets: { app }, observations: {} };
  service.configure(app, document, manager);
  const original = api.request.getMockImplementation();
  api.request.mockImplementation(async (route, args) => {
    if (route.endsWith('/contents/{path}') && args.path.startsWith(`apps/${app}/`)) {
      const err = new Error('not found'); err.status = 404; throw err;
    }
    return original(route, args);
  });
  await expect(service.prepare('databases', manager, app)).rejects.toThrow('pas de base');
  const candidate = await service.prepare('runtime', manager, app);
  const dir = `apps/${app}/crossplane/prod`;
  expect(candidate.files[`${dir}/cloudrun-claim.yaml`]).toBeDefined();
  expect(candidate.files[`${dir}/ecs-task-definition.yaml`]).toBeDefined();
  expect(JSON.stringify(candidate.files)).not.toMatch(/DB_PASSWORD|cloudsql|rds-instance/);
  const task = yaml.load(candidate.files[`${dir}/ecs-task-definition.yaml`]);
  expect(JSON.parse(task.spec.forProvider.containerDefinitions)[0].portMappings[0].containerPort).toBe(3000);
  await service.approve(candidate.id, head, manager);
  const dns = await service.prepare('dns', manager, app);
  expect(dns.files[`${dir}/healthcheck.yaml`]).toBeDefined();
  expect(dns.files[`${dir}/healthcheck-latch-http.yaml`]).toBeUndefined();
  expect(yaml.load(dns.files[`${dir}/record-primary.yaml`]).spec.forProvider.healthCheckIdSelector.matchLabels['cnp-failover']).toBe('health');
});

test('la disponibilité refuse les preuves d’un ancien profil et les dates futures', () => {
  const { createHash } = require('crypto');
  service.rows();
  const operations = require('../src/services/failover-operations');
  operations.list('app4-pixelcam');
  db.prepare("DELETE FROM failover_operations WHERE app=?").run('app4-pixelcam');
  for (const stage of ['databases', 'runtime', 'dns']) {
    db.prepare(`INSERT INTO failover_candidates (id,stage,base_sha,head_sha,pr_number,pr_url,files,input_hash,state,requested_by,created_at,app_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(stage, stage, base, head, 1, 'url', '{}', 'hash', 'published', manager.id, new Date().toISOString(), 'app4-pixelcam');
  }
  const dep = { appName: 'app4-pixelcam', environment: 'prod', targetCluster: 'gcp' };
  const currentHash = createHash('sha256').update(JSON.stringify(service.profileFor('app4-pixelcam'))).digest('hex');
  db.prepare('INSERT INTO failover_operations VALUES (?,?,?,?,?,?,?,?,?)').run('health-proof', 'app4-pixelcam', 'health', 'completed', 'old-profile', manager.id,
    JSON.stringify({ verified: true, state: 'WAIT_SIGNALS', observed_at: Date.now() / 1000 }), new Date().toISOString(), null);
  expect(service.readiness(dep).phase).toBe('deploying');
  db.prepare('UPDATE failover_operations SET input_hash=? WHERE id=?').run(currentHash, 'health-proof');
  expect(service.readiness(dep).phase).toBe('success');
  db.prepare('UPDATE failover_operations SET result=? WHERE id=?').run(JSON.stringify({ verified: true, observed_at: Date.now() / 1000 + 600 }), 'health-proof');
  expect(service.readiness(dep).phase).toBe('deploying');
});
