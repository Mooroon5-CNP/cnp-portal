'use strict';

jest.mock('../src/config/env', () => ({
  config: { github: { configRepoName: 'team/config', configRepoToken: 'test-token' }, gcp: {},
    azure: { namePrefix: 'cnp-sov', regionKey: 'fr', nameSuffix: 'abc123', environmentDomain: 'env.example.io' } },
}));
jest.mock('../src/clients/github', () => ({ getLatestRun: jest.fn(), getRuns: jest.fn(), getRunJobs: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({ getV2ServiceUrl: jest.fn(), getAzureAppStatus: jest.fn() }));
jest.mock('../src/services/github', () => ({
  ...jest.requireActual('../src/services/github'), getFileContent: jest.fn(), getPullRequestStatus: jest.fn(),
}));
jest.mock('../src/services/environment-deployment', () => ({
  validate: jest.fn(), workflowName: appName => `cnp-${appName}.yml`,
  onboard: jest.fn().mockResolvedValue(), reconcile: jest.fn(), review: jest.fn(), remove: jest.fn(),
}));
jest.mock('../src/services/onboarding', () => ({ onboardApp: jest.fn().mockResolvedValue(), offboardApp: jest.fn() }));

const request = require('supertest');
const express = require('express');
const path = require('path');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const environmentService = require('../src/services/environment-deployment');
const onboarding = require('../src/services/onboarding');
const githubClient = require('../src/clients/github');
const k8sClient = require('../src/clients/kubernetes');
const { azureAppStatusFrom } = jest.requireActual('../src/clients/kubernetes');

const managerId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../src/views'));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  req.user = { id: managerId, username: 'test', active: true, role: 'manager' };
  req.session = { userId: managerId };
  req.flash = jest.fn();
  res.locals.flash = {};
  res.locals.pendingMrCount = 0;
  next();
});
app.use('/deployments', require('../src/routes/deployments'));

const form = { appName: 'todo-az', githubRepoUrl: 'https://github.com/team/todo', appPort: '8080', targetCluster: 'azure', environment: 'dev' };

beforeEach(() => {
  jest.clearAllMocks();
  db.prepare('DELETE FROM deployment_team_access').run();
  db.prepare('DELETE FROM deployments').run();
});

test('un déploiement Azure passe par le service d\'environnements dev/prod, avec son cloud', async () => {
  const res = await request(app).post('/deployments').type('form').send(form);
  expect(res.status).toBe(302);
  expect(environmentService.validate).toHaveBeenCalledWith('dev', 'todo-az', 'azure');
  expect(environmentService.onboard).toHaveBeenCalledWith(expect.objectContaining({ appName: 'todo-az', targetCluster: 'azure', environment: 'dev' }));
  expect(onboarding.onboardApp).not.toHaveBeenCalled();
  // listForUser(null) renvoie les lignes brutes de la base (colonnes en snake_case).
  const row = deployments.listForUser(null).find(d => d.app_name === 'todo-az');
  expect(row.deployment_environment).toBe('dev');
  expect(row.target_cluster).toBe('azure');
});

test('Azure en production est enregistré comme tel', async () => {
  await request(app).post('/deployments').type('form').send({ ...form, environment: 'prod' });
  const row = deployments.listForUser(null).find(d => d.app_name === 'todo-az');
  expect(row.deployment_environment).toBe('prod');
  expect(row.target_cluster).toBe('azure');
});

test('Azure : un nom refusé par la validation n\'enregistre rien', async () => {
  environmentService.validate.mockImplementationOnce(() => { throw new Error('Nom invalide'); });
  const res = await request(app).post('/deployments').type('form').send({ ...form, appName: 'Mauvais_Nom' });
  expect(res.status).toBe(302);
  expect(environmentService.onboard).not.toHaveBeenCalled();
  expect(deployments.listForUser(null)).toHaveLength(0);
});

test('GCP garde le service d\'environnements', async () => {
  await request(app).post('/deployments').type('form').send({ ...form, targetCluster: 'gcp' });
  expect(environmentService.onboard).toHaveBeenCalled();
  expect(onboarding.onboardApp).not.toHaveBeenCalled();
});

describe('statut d\'un déploiement Azure après la CI', () => {
  function azureDeployment() {
    const dep = deployments.create({
      appName: 'todo-az', githubRepoUrl: 'https://github.com/team/todo', appPort: 8080,
      targetCluster: 'azure', environment: 'legacy', ownerUserId: managerId,
    });
    deployments.updateOnboardingStatus(dep.id, 'ready');
    return dep;
  }
  const status = id => request(app).get(`/deployments/${id}/status`);

  beforeEach(() => githubClient.getLatestRun.mockResolvedValue({ id: 7, status: 'completed', conclusion: 'success' }));

  test('CI réussie mais serveur PostgreSQL pas prêt : pas « déployée »', async () => {
    k8sClient.getAzureAppStatus.mockResolvedValue({ phase: 'server', failure: null });
    const dep = azureDeployment();
    const res = await status(dep.id);
    expect(res.body.phase).toBe('running');
    expect(res.body.message).toContain('serveur PostgreSQL');
    expect(k8sClient.getAzureAppStatus).toHaveBeenCalledWith('todo-az', {
      serverName: 'cnp-sov-fr-todo-az-dev-abc123', databaseName: 'todo-az-appdb',
    });
  });

  test('Container App prête : succès avec l\'URL Azure', async () => {
    k8sClient.getAzureAppStatus.mockResolvedValue({ phase: 'ready', failure: null });
    const res = await status(azureDeployment().id);
    expect(res.body.phase).toBe('success');
    expect(res.body.cloudRunUrl).toBe('https://todo-az.env.example.io');
  });

  test('échec de création côté Azure : failed avec la cause', async () => {
    k8sClient.getAzureAppStatus.mockResolvedValue({ phase: 'failed', failure: 'Container App : image introuvable' });
    const res = await status(azureDeployment().id);
    expect(res.body.phase).toBe('failed');
    expect(res.body.detail).toContain('image introuvable');
  });

  test('API Kubernetes indisponible : on continue d\'attendre, on ne déclare rien', async () => {
    k8sClient.getAzureAppStatus.mockRejectedValue(new Error('timeout'));
    const res = await status(azureDeployment().id);
    expect(res.body.phase).toBe('running');
  });

  test('CI en cours : Crossplane n\'est même pas interrogé', async () => {
    githubClient.getLatestRun.mockResolvedValue({ id: 7, status: 'in_progress' });
    const res = await status(azureDeployment().id);
    expect(res.body.phase).toBe('running');
    expect(k8sClient.getAzureAppStatus).not.toHaveBeenCalled();
  });
});

describe('azureAppStatusFrom (lecture des conditions Crossplane)', () => {
  const cond = (type, status, extra = {}) => ({ type, status, ...extra });
  const obj = (...conditions) => ({ status: { conditions: conditions } });
  const ok = obj(cond('Ready', 'True'), cond('Synced', 'True'));
  const creating = obj(cond('Ready', 'False', { reason: 'Creating' }), cond('Synced', 'True'));

  test('aucune ressource : en attente d\'Argo CD', () => {
    expect(azureAppStatusFrom({}).phase).toBe('waiting-argocd');
  });
  test('étapes dans l\'ordre serveur, base, Container App', () => {
    expect(azureAppStatusFrom({ server: creating }).phase).toBe('server');
    expect(azureAppStatusFrom({ server: ok, database: creating }).phase).toBe('database');
    expect(azureAppStatusFrom({ server: ok, database: ok, containerApp: creating }).phase).toBe('containerapp');
    expect(azureAppStatusFrom({ server: ok, database: ok }).phase).toBe('containerapp');
  });
  test('tout prêt', () => {
    expect(azureAppStatusFrom({ server: ok, database: ok, containerApp: ok }).phase).toBe('ready');
  });
  test('échec de création asynchrone : failed avec le message (tronqué)', () => {
    const failed = obj(cond('Ready', 'False'), cond('Synced', 'False', { reason: 'ReconcileError' }),
      cond('LastAsyncOperation', 'False', { reason: 'AsyncCreateFailure', message: `manifest tagged by placeholder ${'x'.repeat(600)}` }));
    const res = azureAppStatusFrom({ server: ok, database: ok, containerApp: failed });
    expect(res.phase).toBe('failed');
    expect(res.failure).toContain('Container App');
    expect(res.failure.length).toBeLessThan(450);
  });
  test('une simple ReconcileError passagère n\'est pas un échec', () => {
    const transient = obj(cond('Ready', 'False'), cond('Synced', 'False', { reason: 'ReconcileError' }));
    expect(azureAppStatusFrom({ server: ok, database: ok, containerApp: transient }).phase).toBe('containerapp');
  });
});

describe('page de détail d\'un déploiement Azure dev/prod', () => {
  function envDeployment(environment = 'dev') {
    const dep = deployments.create({
      appName: 'todo-az', githubRepoUrl: 'https://github.com/team/todo', appPort: 8080,
      targetCluster: 'azure', environment, ownerUserId: managerId,
    });
    deployments.updateOnboardingStatus(dep.id, 'ready');
    return dep;
  }
  const detail = id => request(app).get(`/deployments/${id}`);

  beforeEach(() => {
    githubClient.getRuns.mockResolvedValue([]);
    githubClient.getLatestRun.mockResolvedValue(null);
    githubClient.getRunJobs.mockResolvedValue([]);
  });

  test('le lien de l\'application n\'apparaît PAS tant que les ressources Azure ne sont pas prêtes', async () => {
    environmentService.reconcile.mockResolvedValue({ phase: 'deploying', message: 'Création du serveur PostgreSQL privé en cours' });
    const res = await detail(envDeployment().id);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="url-card"');
    expect(res.text).not.toContain('href="https://todo-az-dev.env.example.io"');
  });

  test('l\'adresse affichée est celle d\'Azure, jamais l\'adresse GCP <app>.dev.apps.mooroon5.fr', async () => {
    environmentService.reconcile.mockResolvedValue({ phase: 'running', message: 'Pipeline en cours.' });
    const res = await detail(envDeployment().id);
    expect(res.text).toContain('id="application-address"');
    expect(res.text).toContain('todo-az-dev.env.example.io');
    expect(res.text).not.toContain('apps.mooroon5.fr');
    expect(res.text).not.toContain('routage DNS et HTTPS');
  });

  test('le lien apparaît une fois le statut « success »', async () => {
    environmentService.reconcile.mockResolvedValue({ phase: 'success', applicationUrl: 'https://todo-az-dev.env.example.io' });
    const res = await detail(envDeployment().id);
    expect(res.text).toContain('id="url-card"');
    expect(res.text).toContain('https://todo-az-dev.env.example.io');
  });
});
