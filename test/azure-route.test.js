'use strict';

jest.mock('../src/config/env', () => ({
  config: { github: { configRepoName: 'team/config', configRepoToken: 'test-token' }, gcp: {}, azure: { environmentDomain: 'env.example.io' } },
}));
jest.mock('../src/clients/github', () => ({ getLatestRun: jest.fn(), getRuns: jest.fn(), getRunJobs: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({ getV2ServiceUrl: jest.fn() }));
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

test('un déploiement Azure passe par onboardApp, pas par le service d\'environnements GCP', async () => {
  const res = await request(app).post('/deployments').type('form').send(form);
  expect(res.status).toBe(302);
  expect(onboarding.onboardApp).toHaveBeenCalledWith(expect.objectContaining({
    appName: 'todo-az', targetCluster: 'azure', appPort: 8080,
  }));
  expect(environmentService.onboard).not.toHaveBeenCalled();
  // listForUser(null) renvoie les lignes brutes de la base (colonnes en snake_case).
  const row = deployments.listForUser(null).find(d => d.app_name === 'todo-az');
  expect(row.deployment_environment).toBe('legacy');
  expect(row.target_cluster).toBe('azure');
});

test('Azure : un nom invalide est refusé avant tout enregistrement', async () => {
  const res = await request(app).post('/deployments').type('form').send({ ...form, appName: 'Mauvais_Nom' });
  expect(res.status).toBe(302);
  expect(onboarding.onboardApp).not.toHaveBeenCalled();
  expect(deployments.listForUser(null)).toHaveLength(0);
});

test('GCP garde le service d\'environnements', async () => {
  await request(app).post('/deployments').type('form').send({ ...form, targetCluster: 'gcp' });
  expect(environmentService.onboard).toHaveBeenCalled();
  expect(onboarding.onboardApp).not.toHaveBeenCalled();
});
