'use strict';

// Les paramètres de plateforme (IP du LB, identité Cloud Run, groupe de sécurité et CA de RDS, orchestration) ne
// doivent plus dépendre du profil du pilote : un profil neuf se construit depuis failover-platform.json.
jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'Mooroon5-CNP/config-repo' } } }));
jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn() }));
jest.mock('../src/services/environment-deployment', () => ({ commitFiles: jest.fn() }));
jest.mock('../src/models/deployment', () => ({ listForUser: jest.fn() }));
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const service = require('../src/services/environment-failover');
const operations = require('../src/services/failover-operations');

const manager = { id: 'manager-test', role: 'manager' };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-failover-platform-'));
const CA = '-----BEGIN CERTIFICATE-----\nMIIBplatform\n-----END CERTIFICATE-----';
const platform = (overrides = {}) => ({
  gcp: { gcp_lb_ip: '34.54.71.90', gcp_runtime: { service_account: 'runtime@example.test', subnetwork: 'projects/p/regions/r/subnetworks/s' } },
  aws: { database_security_group_id: 'sg-0123456789abcdef0', database_ca_pem: CA },
  automation: {
    worker_image: `804210702561.dkr.ecr.eu-west-3.amazonaws.com/cnp-failover-apps@sha256:${'a'.repeat(64)}`,
    ecs_cluster_arn: 'arn:aws:ecs:eu-west-3:804210702561:cluster/cnp-cluster', ecs_security_group_id: 'sg-0aaaaaaaaaaaaaaaa',
    public_subnet_ids: ['subnet-1', 'subnet-2'], subscription_ca_path_on_rds: null, kube_context: 'ctx',
    bootstrap_task_definition: 'cnp-failover-platform-bootstrap', worker_task_definition: 'cnp-failover-platform-worker',
  },
  ...overrides,
});
const contract = { database: 'todos' };       // le schéma se lit dans la base de l'application : seul son nom est fourni
const write = (name, value) => { const file = path.join(temp, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
let requests;

beforeEach(() => {
  jest.clearAllMocks();
  db.exec('DROP TABLE IF EXISTS failover_candidates; DROP TABLE IF EXISTS failover_profiles; DROP TABLE IF EXISTS failover_adoptions');
  requests = [];
  execFile.mockImplementation((command, args, options, callback) => ({
    stdin: { end: jest.fn(body => { requests.push(JSON.parse(body)); callback(null, JSON.stringify({ priority: 77 })); }) },
  }));
  deployments.listForUser.mockReturnValue([{ app_name: 'weather-api', deployment_environment: 'prod', target_cluster: 'gcp', app_port: 8081 }]);
  process.env.CNP_FAILOVER_PLATFORM = write('platform.json', platform());
});
afterAll(() => {
  for (const key of ['CNP_FAILOVER_PLATFORM']) delete process.env[key];
  fs.rmSync(temp, { recursive: true, force: true });
});

test('un profil PostgreSQL se construit depuis failover-platform.json, sans aucun fichier du pilote', async () => {
  await operations.createProfile('weather-api', 'postgres', contract, manager);
  const { profile } = service.profileFor('weather-api');
  expect(profile.gcp.gcp_lb_ip).toBe('34.54.71.90');
  expect(profile.gcp.gcp_runtime.service_account).toBe('runtime@example.test');
  expect(profile.aws.database_security_group_id).toBe('sg-0123456789abcdef0');
  expect(profile.aws.database_ca_pem).toBe(CA);
  expect(profile.aws.listener_priority).toBe(77);
  expect(profile.automation.ecs_cluster_arn).toContain('cluster/cnp-cluster');
  expect(profile.gcp.container_port).toBe(8081);
  expect(profile.gcp.database_name).toBe('todos');
  expect(profile.gcp.sql_contract).toEqual({ database: 'todos' });
  expect(profile.aws.sql_contract).toEqual({ database: 'todos' });
  expect(requests[0]).toMatchObject({ action: 'allocate-listener', app: 'weather-api' });
});

test('aucun nom de base n’est demandé : la plateforme prend appdb et le transmet par DB_NAME', async () => {
  await operations.createProfile('weather-api', 'postgres', null, manager);
  const { profile } = service.profileFor('weather-api');
  expect([profile.gcp.database_name, profile.aws.database_name]).toEqual(['appdb', 'appdb']);
  expect(profile.gcp.sql_contract).toEqual({ database: 'appdb' });
});
test('le profil créé ne contient aucune trace d’une autre application', async () => {
  await operations.createProfile('weather-api', 'postgres', contract, manager);
  expect(JSON.stringify(service.profileFor('weather-api'))).not.toMatch(/app4-pixelcam|pixelcalm|pixelcam/i);
});

test('sans fichier de plateforme, l’erreur dit où fournir les paramètres', () => {
  // Un fichier absent, et non une variable supprimée : un poste de développement a souvent un vrai data/failover-platform.json.
  process.env.CNP_FAILOVER_PLATFORM = path.join(temp, 'absent-platform.json');
  expect(() => service.platform()).toThrow('CNP_FAILOVER_PLATFORM');
});

test('un fichier de plateforme incomplet est refusé en nommant les champs, et rien n’est enregistré', async () => {
  const broken = platform();
  delete broken.aws.database_security_group_id;
  broken.gcp.gcp_lb_ip = 'pas-une-ip';
  delete broken.automation.kube_context;
  process.env.CNP_FAILOVER_PLATFORM = write('broken.json', broken);
  await expect(operations.createProfile('weather-api', 'postgres', contract, manager))
    .rejects.toThrow(/gcp\.gcp_lb_ip.*aws\.database_security_group_id.*automation\.kube_context/);
  expect(service.profileFor('weather-api')).toBeNull();
});

test('les tables ne se décrivent plus : un contrat déclaratif ou un nom de base invalide est refusé avant tout enregistrement', async () => {
  const declared = { database: 'todos', tables: [{ name: 'todos', columns: [{ name: 'id', type: 'bigint', primary_key: true }] }] };
  await expect(operations.createProfile('weather-api', 'postgres', declared, manager)).rejects.toThrow('lues dans la base');
  for (const bad of [{}, { database: 'Todos' }, { database: 'x; DROP' }, { database: '' }, { database: 'ok', extra: 1 }]) {
    await expect(operations.createProfile('weather-api', 'postgres', bad, manager)).rejects.toThrow(/Nom de base invalide|lues dans la base/);
  }
  expect(service.profileFor('weather-api')).toBeNull();
  expect(requests).toHaveLength(0);
});

test('seul un manager crée un profil, et seulement pour une production GCP', async () => {
  await expect(operations.createProfile('weather-api', 'postgres', contract, { id: 'dev', role: 'dev' })).rejects.toThrow('manager');
  deployments.listForUser.mockReturnValue([{ app_name: 'weather-api', deployment_environment: 'prod', target_cluster: 'azure' }]);
  await expect(operations.createProfile('weather-api', 'postgres', contract, manager)).rejects.toThrow('production GCP');
});

describe('régime plateforme du worker', () => {
  test('sans les tâches ECS de la pile plateforme, aucun profil PostgreSQL ne se crée', async () => {
    const missing = platform();
    delete missing.automation.worker_task_definition;
    process.env.CNP_FAILOVER_PLATFORM = write('missing-tasks.json', missing);
    await expect(operations.createProfile('weather-api', 'postgres', contract, manager)).rejects.toThrow('worker_task_definition');
    expect(service.profileFor('weather-api')).toBeNull();
  });
  test('une app PostgreSQL a toujours l’étape worker, après les DNS', () => {
    expect(service.stagesFor({ profile: { automation: {} } })).toEqual(['databases', 'runtime', 'dns', 'worker']);
  });
  test('toute app PostgreSQL neuve est en régime plateforme : RDS prend le mot de passe de son Secret, l’étape worker suit les DNS', async () => {
    await operations.createProfile('weather-api', 'postgres', contract, manager);
    const document = service.profileFor('weather-api');
    expect(document.profile.aws.master_password_secret).toBe('cnp-weather-api-sql');
    expect(document.profile.aws.master_password_secret).toBe(document.profile.gcp.credentials_secret_name);
    expect(document.profile.automation).toMatchObject({ regime: 'platform', worker_task_definition: 'cnp-failover-platform-worker' });
    expect(service.stagesFor(document)).toEqual(['databases', 'runtime', 'dns', 'worker']);
  });
  test('aucun plan Terraform de secrets : les conteneurs naissent à l’initialisation', async () => {
    await operations.createProfile('weather-api', 'postgres', contract, manager);
    expect(() => operations.start('weather-api', 'credentials-plan', manager)).toThrow('inconnue');
  });
  test('le failover sans base n’existe plus : création refusée, un seul parcours de publication', async () => {
    await expect(operations.createProfile('weather-api', 'stateless', null, manager)).rejects.toThrow('PostgreSQL requis');
    expect(service.profileFor('weather-api')).toBeNull();
    expect(service.stagesFor({ profile: { mode: 'stateless' } })).toEqual(['databases', 'runtime', 'dns', 'worker']);
  });
});
test('sans choix, la facturation reste à l’usage', async () => {
  await operations.createProfile('weather-api', 'postgres', null, manager);
  expect(service.profileFor('weather-api').profile.gcp.billing_mode).toBeUndefined();
});
test('la facturation « à l’instance » choisie au déploiement passe dans le profil', async () => {
  deployments.listForUser.mockReturnValue([{ app_name: 'weather-api', deployment_environment: 'prod', target_cluster: 'gcp', app_port: 8081, billing_mode: 'instance' }]);
  await operations.createProfile('weather-api', 'postgres', null, manager);
  expect(service.profileFor('weather-api').profile.gcp.billing_mode).toBe('instance');
});
