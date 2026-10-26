'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'team/config', configRepoToken: 'test-token' }, gcp: {} } }));
jest.mock('../src/clients/github', () => ({ getLatestRun: jest.fn(), getRuns: jest.fn(), getRunJobs: jest.fn() }));
jest.mock('../src/clients/kubernetes', () => ({ getV2ServiceUrl: jest.fn() }));
jest.mock('../src/services/github', () => ({
    ...jest.requireActual('../src/services/github'), getFileContent: jest.fn(), getPullRequestStatus: jest.fn(),
}));
jest.mock('../src/services/environment-deployment', () => ({
    validate: jest.fn((environment) => { if (!['dev', 'prod'].includes(environment)) throw new Error('Environnement invalide'); }),
    workflowName: appName => `cnp-${appName}.yml`,
    onboard: jest.fn(), reconcile: jest.fn(), review: jest.fn(), remove: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const path = require('path');
const db = require('../src/models/db');
const deployments = require('../src/models/deployment');
const service = require('../src/services/environment-deployment');
const github = require('../src/clients/github');
const repositories = require('../src/services/github');
const kubernetes = require('../src/clients/kubernetes');
const managerId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
const revision = 'a'.repeat(40);
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../src/views'));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    req.user = { id: req.get('X-user-id') || managerId, username: 'test', active: true, role: req.get('X-role') || 'manager' };
    req.session = { userId: req.user.id };
    req.flash = jest.fn();
    res.locals.flash = {};
    res.locals.pendingMrCount = 0;
    next();
});
app.use('/deployments', require('../src/routes/deployments'));

const input = { appName: 'sample-app', githubRepoUrl: 'https://github.com/team/sample', appPort: '8080', targetCluster: 'gcp' };
function create(environment) {
    const dep = deployments.create({ ...input, appPort: 8080, environment, ownerUserId: managerId });
    deployments.updateOnboardingStatus(dep.id, 'ready');
    return deployments.get(dep.id);
}

beforeEach(() => {
    jest.clearAllMocks();
    db.prepare('DELETE FROM deployment_team_access').run();
    db.prepare('DELETE FROM deployments').run();
    service.onboard.mockResolvedValue();
    service.review.mockResolvedValue();
    service.remove.mockResolvedValue();
    service.reconcile.mockResolvedValue({ phase: 'approval', message: 'Validation manager requise.', revision, prUrl: 'https://example.test/pr' });
    github.getRuns.mockResolvedValue([]);
    github.getLatestRun.mockResolvedValue(null);
    github.getRunJobs.mockResolvedValue([]);
    repositories.getFileContent.mockResolvedValue(null);
    kubernetes.getV2ServiceUrl.mockResolvedValue(null);
});

test('the form exposes dev/main and prod/approval choices', async () => {
    const response = await request(app).get('/deployments');
    expect(response.status).toBe(200);
    expect(response.text).toContain('name="environment"');
    expect(response.text).toContain('automatique depuis main');
    expect(response.text).toContain('depuis prod, après validation manager');
    expect(response.text).toContain('.dev.apps.mooroon5.fr');
});

test('MCP links retain the selected deployment environment', async () => {
    create('dev'); create('prod');
    const response = await request(app).get('/deployments');
    expect(response.status).toBe(200);
    expect(response.text).toContain('/mcp-chat?applicationId=sample-app&amp;environment=dev');
    expect(response.text).toContain('/mcp-chat?applicationId=sample-app&amp;environment=prod');
});

test('environment addresses never advertise DNS readiness from runtime readiness alone', async () => {
    const dep = create('prod');
    service.reconcile.mockResolvedValue({ phase: 'success', revision, cloudRunUrl: 'https://sample-app-prod.run.app', applicationUrl: 'https://sample-app.apps.mooroon5.fr' });
    const response = await request(app).get(`/deployments/${dep.id}`);
    expect(response.status).toBe(200);
    expect(response.text).toContain('https://sample-app.apps.mooroon5.fr');
    expect(response.text).not.toContain('href="https://sample-app-prod.run.app"');
    expect(response.text).toContain('href="https://sample-app.apps.mooroon5.fr"');
    service.reconcile.mockResolvedValue({ phase: 'deploying', revision, cloudRunUrl: 'https://sample-app-dev.run.app' });
    const dev = create('dev');
    const devResponse = await request(app).get(`/deployments/${dev.id}`);
    expect(devResponse.text).toContain('https://sample-app.dev.apps.mooroon5.fr');
    expect(devResponse.text).not.toContain('href="https://sample-app.dev.apps.mooroon5.fr"');
});

test('selection is persisted and passed to onboarding', async () => {
    const response = await request(app).post('/deployments').type('form').send({ ...input, environment: 'prod' });
    expect(response.status).toBe(302);
    expect(service.onboard).toHaveBeenCalledWith(expect.objectContaining({ environment: 'prod', sourceBranch: 'prod', resourceName: 'sample-app-prod' }));
});

test('the default deployment selection is dev', async () => {
    await request(app).post('/deployments').type('form').send(input);
    expect(service.onboard).toHaveBeenCalledWith(expect.objectContaining({ environment: 'dev', sourceBranch: 'main' }));
});

test('invalid environments are rejected before creating a deployment', async () => {
    await request(app).post('/deployments').type('form').send({ ...input, environment: 'staging' });
    expect(deployments.listForUser(null)).toHaveLength(0);
    expect(service.onboard).not.toHaveBeenCalled();
});

test('invalid ports are rejected before creating a deployment', async () => {
    await request(app).post('/deployments').type('form').send({ ...input, appPort: '65536', environment: 'dev' });
    expect(deployments.listForUser(null)).toHaveLength(0);
    expect(service.onboard).not.toHaveBeenCalled();
});

test('dev and prod coexist while a duplicate environment cannot create another record', async () => {
    create('dev');
    create('prod');
    await request(app).post('/deployments').type('form').send({ ...input, environment: 'dev' });
    expect(deployments.listForUser(null)).toHaveLength(2);
    expect(service.onboard).not.toHaveBeenCalled();
});

test('status reports approval instead of interpreting CI success as deployment success', async () => {
    const dep = create('prod');
    const response = await request(app).get(`/deployments/${dep.id}/status`);
    expect(response.status).toBe(200);
    expect(response.body.phase).toBe('approval');
    expect(response.body.cloudRunUrl).toBeUndefined();
});

test('production detail only renders manager approval controls for managers', async () => {
    const dep = create('prod');
    const manager = await request(app).get(`/deployments/${dep.id}`);
    expect(manager.status).toBe(200);
    expect(manager.text).toContain('Approuver la production');
    expect(github.getRuns).toHaveBeenCalledWith('team', 'sample', 5, 'prod', 'cnp-sample-app.yml');
    const dev = await request(app).get(`/deployments/${dep.id}`).set('X-role', 'dev');
    expect(dev.status).toBe(200);
    expect(dev.text).not.toContain('Approuver la production');
    expect(manager.text).toContain("L'autre environnement, le pipeline et les secrets partagés seront conservés.");
});

test('a developer cannot bypass approval by calling the production endpoint directly', async () => {
    const dep = create('prod');
    const response = await request(app).post(`/deployments/${dep.id}/releases/${revision}/approve`).set('X-role', 'dev');
    expect(response.status).toBe(403);
    expect(service.review).not.toHaveBeenCalled();
});

test('manager approval forwards the selected candidate and reviewer identity', async () => {
    const dep = create('prod');
    const response = await request(app).post(`/deployments/${dep.id}/releases/${revision}/approve`);
    expect(response.status).toBe(302);
    expect(service.review).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id, environment: 'prod' }), revision, true, { reviewedBy: managerId });
});

test('manager rejection closes the selected candidate through the release service', async () => {
    const dep = create('prod');
    const response = await request(app).post(`/deployments/${dep.id}/releases/${revision}/reject`);
    expect(response.status).toBe(302);
    expect(service.review).toHaveBeenCalledWith(expect.objectContaining({ id: dep.id }), revision, false, { reviewedBy: managerId });
});

test('another user cannot read or attach an environment to an inaccessible app', async () => {
    const dep = create('dev');
    const status = await request(app).get(`/deployments/${dep.id}/status`).set('X-user-id', 'outsider').set('X-role', 'dev');
    expect(status.status).toBe(403);
    const detail = await request(app).get(`/deployments/${dep.id}`).set('X-user-id', 'outsider').set('X-role', 'dev');
    expect(detail.status).toBe(403);
    const createOther = await request(app).post('/deployments').set('X-user-id', 'outsider').set('X-role', 'dev').type('form').send({ ...input, environment: 'prod' });
    expect(createOther.status).toBe(403);
    expect(service.onboard).not.toHaveBeenCalled();
});

test('an old cached URL is not presented as a ready new environment revision', async () => {
    const dep = create('dev');
    deployments.updateCloudRunUrl(dep.id, 'https://old-revision.test');
    service.reconcile.mockResolvedValue({ phase: 'deploying', message: 'Attente de Cloud Run.', revision, cloudRunUrl: 'https://old-revision.test' });
    const detail = await request(app).get(`/deployments/${dep.id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).not.toContain('Ouvrir l\'application ↗');
    expect(detail.text).not.toContain('Votre application est déployée.');
    expect(kubernetes.getV2ServiceUrl).not.toHaveBeenCalled();
});

test('environment polling tracks revision changes and does not stop after CI success', async () => {
    const dep = create('prod');
    const detail = await request(app).get(`/deployments/${dep.id}`);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('(data.revision || \'\') !== initialRevision');
    expect(detail.text).toContain('window.setTimeout(pollEnvironment, 5000)');
});

test('deletion only cleans the selected environment and keeps its sibling record', async () => {
    const dev = create('dev');
    const prod = create('prod');
    await request(app).post(`/deployments/${dev.id}/delete`);
    expect(service.remove).toHaveBeenCalledWith(expect.objectContaining({ id: dev.id, environment: 'dev' }));
    expect(deployments.get(dev.id)).toBeNull();
    expect(deployments.get(prod.id)).toEqual(expect.objectContaining({ environment: 'prod' }));
});

test('failed cleanup retains the record so deletion can be retried', async () => {
    const dep = create('dev');
    service.remove.mockRejectedValueOnce(new Error('Provider unavailable'));
    await request(app).post(`/deployments/${dep.id}/delete`);
    expect(deployments.get(dep.id)).toMatchObject({ onboardingStatus: 'failed' });
});

test.each(['success', 'failure'])('late setup %s cannot overwrite an in-progress deletion', async outcome => {
    let finishSetup;
    let failSetup;
    service.onboard.mockImplementationOnce(() => new Promise((resolve, reject) => {
        finishSetup = resolve;
        failSetup = reject;
    }));
    const created = await request(app).post('/deployments').type('form').send({ ...input, environment: 'dev' });
    const id = created.headers.location.split('/').pop();
    let beginRemoval;
    let finishRemoval;
    const removalStarted = new Promise(resolve => { beginRemoval = resolve; });
    const removalFinished = new Promise(resolve => { finishRemoval = resolve; });
    service.remove.mockImplementationOnce(async () => {
        beginRemoval();
        await removalFinished;
    });
    const deleting = request(app).post(`/deployments/${id}/delete`).then(response => response);
    await removalStarted;
    if (outcome === 'success') finishSetup();
    else failSetup(new Error('Setup finished with an error'));
    await new Promise(resolve => setImmediate(resolve));
    expect(deployments.get(id).onboardingStatus).toBe('deleting');
    finishRemoval();
    expect((await deleting).status).toBe(302);
    expect(deployments.get(id)).toBeNull();
});

test('legacy records retain their original service and branch identity', () => {
    const dep = deployments.create({ ...input, appPort: 8080, ownerUserId: managerId });
    expect(dep.environment).toBe('legacy');
    expect(dep.resourceName).toBe('sample-app');
    expect(dep.sourceBranch).toBe('main');
});
