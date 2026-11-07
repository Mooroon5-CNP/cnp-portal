'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'team/config', configRepoToken: 'test-token' }, gcp: {} } }));
jest.mock('../src/clients/github', () => ({ getLatestRun: jest.fn(), getRuns: jest.fn(), getRunJobs: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({ getV2ServiceUrl: jest.fn() }));
jest.mock('../src/services/environment-deployment', () => ({
    validate: jest.fn(),
    workflowName: appName => `cnp-${appName}.yml`,
    onboard: jest.fn(), reconcile: jest.fn(), review: jest.fn(), remove: jest.fn(),
}));
jest.mock('../src/services/repo-scaffolder', () => {
    class ScaffoldError extends Error {}
    return {
        ScaffoldError,
        scaffoldRepository: jest.fn(),
        LANGUAGES: { node: 'Node.js', python: 'Python', fullstack: 'Fullstack' },
    };
});

const request = require('supertest');
const express = require('express');
const path = require('path');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const environmentService = require('../src/services/environment-deployment');
const scaffolder = require('../src/services/repo-scaffolder');

const managerId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
const flash = jest.fn();
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../src/views'));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    req.user = { id: managerId, username: 'test', active: true, role: 'manager' };
    req.session = { userId: managerId };
    req.flash = flash;
    res.locals.flash = {};
    res.locals.pendingMrCount = 0;
    next();
});
app.use('/deployments', require('../src/routes/deployments'));

const created = { owner: 'Mooroon5-CNP', repo: 'fresh-app', url: 'https://github.com/Mooroon5-CNP/fresh-app', branches: ['main', 'prod'] };

beforeEach(() => {
    jest.clearAllMocks();
    db.prepare('DELETE FROM deployment_team_access').run();
    db.prepare('DELETE FROM deployments').run();
    environmentService.onboard.mockResolvedValue();
    scaffolder.scaffoldRepository.mockResolvedValue(created);
});

test('the modal offers both repository sources and the supported languages', async () => {
    const response = await request(app).get('/deployments');
    expect(response.status).toBe(200);
    expect(response.text).toContain('Dépôt GitHub prêt et existant');
    expect(response.text).toContain('Créer un nouveau dépôt');
    expect(response.text).toContain('<option value="python">Python</option>');
    expect(response.text).toContain('name="githubRepoUrl"');
    expect(response.text).toContain('name="source"');
});

test('new repository: scaffolds the repo, then registers the deployment on its URL', async () => {
    const response = await request(app).post('/deployments').type('form')
        .send({ source: 'new', repoLanguage: 'python', appName: 'fresh-app', appPort: '3000', environment: 'dev', targetCluster: 'gcp' });

    expect(scaffolder.scaffoldRepository).toHaveBeenCalledWith({ name: 'fresh-app', language: 'python', port: 3000 });
    const [row] = deployments.listForUser(null);
    expect(row.github_repo_url).toBe(created.url);
    expect(row.app_name).toBe('fresh-app');
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`/deployments/${row.id}`);
    expect(environmentService.onboard).toHaveBeenCalled();
});

test('new repository: a scaffolding failure shows the message and registers nothing', async () => {
    scaffolder.scaffoldRepository.mockRejectedValue(new scaffolder.ScaffoldError('Le dépôt existe déjà.'));
    const response = await request(app).post('/deployments').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app', appPort: '8080', environment: 'dev', targetCluster: 'gcp' });

    expect(flash).toHaveBeenCalledWith('error', 'Le dépôt existe déjà.');
    expect(response.headers.location).toBe('/deployments');
    expect(deployments.listForUser(null)).toHaveLength(0);
    expect(environmentService.onboard).not.toHaveBeenCalled();
});

test('new repository: an unexpected error is not leaked to the user', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    scaffolder.scaffoldRepository.mockRejectedValue(new Error('token ghs_secret rejected'));
    await request(app).post('/deployments').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app', appPort: '8080', environment: 'dev', targetCluster: 'gcp' });

    expect(flash).toHaveBeenCalledWith('error', expect.not.stringContaining('ghs_secret'));
    expect(deployments.listForUser(null)).toHaveLength(0);
});

test('new repository: no repository is created for an unsupported cloud', async () => {
    await request(app).post('/deployments').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app', appPort: '8080', environment: 'dev', targetCluster: 'aws' });
    expect(scaffolder.scaffoldRepository).not.toHaveBeenCalled();
});

test('existing repository (historical flow): URL still required and nothing is scaffolded', async () => {
    await request(app).post('/deployments').type('form').send({ appName: 'old-app', appPort: '8080', environment: 'dev', targetCluster: 'gcp' });
    expect(flash).toHaveBeenCalledWith('error', "Veuillez renseigner le nom de l'application et l'URL du dépôt GitHub.");

    const response = await request(app).post('/deployments').type('form')
        .send({ appName: 'old-app', githubRepoUrl: 'https://github.com/team/old-app', appPort: '8080', environment: 'dev', targetCluster: 'gcp' });
    expect(scaffolder.scaffoldRepository).not.toHaveBeenCalled();
    expect(deployments.listForUser(null)[0].github_repo_url).toBe('https://github.com/team/old-app');
    expect(response.status).toBe(302);
});

test('an unknown source value falls back to the historical flow', async () => {
    await request(app).post('/deployments').type('form').send({ source: 'whatever', appName: 'old-app', appPort: '8080', environment: 'dev', targetCluster: 'gcp' });
    expect(scaffolder.scaffoldRepository).not.toHaveBeenCalled();
    expect(flash).toHaveBeenCalledWith('error', "Veuillez renseigner le nom de l'application et l'URL du dépôt GitHub.");
});


test('new repository works with the Cloud Run wizard JSON response', async () => {
    const response = await request(app).post('/deployments').set('Accept', 'application/json').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app', targetCluster: 'gcp' });
    expect(response.status).toBe(202);
    expect(response.body.redirect).toBe(`/deployments/${deployments.listForUser(null)[0].id}`);
});

test('scaffolding errors stay JSON for the Cloud Run wizard', async () => {
    scaffolder.scaffoldRepository.mockRejectedValue(new scaffolder.ScaffoldError('Le dépôt existe déjà.'));
    const response = await request(app).post('/deployments').set('Accept', 'application/json').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Le dépôt existe déjà.');
    expect(deployments.listForUser(null)).toHaveLength(0);
});

test('a new repository can register a failover production while keeping the supplied deployment id', async () => {
    const response = await request(app).post('/deployments').set('Accept', 'application/json').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app', environment: 'prod', targetCluster: 'gcp', failoverRequested: 'on' });
    expect(response.status).toBe(202);
    const dep = deployments.get(deployments.listForUser(null)[0].id);
    expect(dep.failoverRequested).toBe(true);
    expect(dep.unsupportedRuntime).toBe(false);
    expect(response.body.redirect).toBe(`/deployments/${dep.id}`);
});

test('invalid failover requests return JSON and never create a repository', async () => {
    const response = await request(app).post('/deployments').set('Accept', 'application/json').type('form')
        .send({ source: 'new', repoLanguage: 'node', appName: 'fresh-app', environment: 'dev', failoverRequested: 'on' });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain('production GCP');
    expect(scaffolder.scaffoldRepository).not.toHaveBeenCalled();
});
