'use strict';

jest.mock('../src/middleware/auth', () => ({ requireAuth: (req, res, next) => req.user ? next() : res.redirect('/auth/login') }));
jest.mock('../src/services/repo-scaffolder', () => ({
    ...jest.requireActual('../src/services/repo-scaffolder'), scaffoldRepository: jest.fn(),
}));
const request = require('supertest');
const express = require('express');
const path = require('path');
const scaffolder = require('../src/services/repo-scaffolder');
const { can } = require('../src/middleware/rbac');
let session;
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../src/views'));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
    req.user = req.get('X-Anonymous') ? null : { role: req.get('X-Role') || 'dev', username: 'test' };
    req.session = session;
    res.locals.user = req.user;
    res.locals.can = permission => can(req.user, permission);
    next();
});
app.use('/repositories', require('../src/routes/repositories'));
app.use('/docs', require('../src/routes/documentation'));
beforeEach(() => { session = {}; jest.clearAllMocks(); });
const input = () => ({ name: 'sample', template: 'sqlite', port: 8080, publicAcknowledged: 'yes', submissionToken: session.repositoryCreationToken });

test('creation is separate from deployment and includes database guidance', async () => {
    const result = await request(app).get('/repositories/new');
    expect(result.status).toBe(200);
    expect(result.text).toContain('Aidez-moi à choisir');
    expect(result.text).toContain('PostgreSQL');
    expect(result.text).toContain('SQLite');
    expect(result.text).toContain('action="/repositories"');
    expect(result.text).not.toContain('action="/deployments"');
});

test('authentication and role checks protect creation', async () => {
    expect((await request(app).get('/repositories/new').set('X-Anonymous', 'yes')).headers.location).toBe('/auth/login');
    expect((await request(app).post('/repositories').set('X-Role', 'viewer').send({})).status).toBe(403);
    expect(scaffolder.scaffoldRepository).not.toHaveBeenCalled();
});

test('success redirects to a result page, never to a deployment action; replay does not create again', async () => {
    await request(app).get('/repositories/new');
    const payload = input();
    scaffolder.scaffoldRepository.mockResolvedValue({ owner: 'team', repo: 'sample', url: 'https://github.com/team/sample', template: 'sqlite', port: 8080 });
    const result = await request(app).post('/repositories').type('form').send(payload);
    expect(result.status).toBe(303);
    expect(result.headers.location).toBe('/repositories/created');
    expect(scaffolder.scaffoldRepository).toHaveBeenCalledWith({ name: 'sample', template: 'sqlite', port: 8080, description: undefined });
    const page = await request(app).get('/repositories/created');
    expect(page.text).toContain('Aucun déploiement');
    expect(page.text).toContain('/deployments#repository=');
    expect(page.text).toContain('Voir le repo sur GitHub');
    expect(page.text).toContain('href="https://github.com/team/sample"');
    expect(page.text).toContain('href="/docs/APPLICATION_TEMPLATE_GUIDE.md"');
    const guide = await request(app).get('/docs/APPLICATION_TEMPLATE_GUIDE.md');
    expect(guide.status).toBe(200);
    expect(guide.text).toContain('Commencer à coder avec les templates CNP');
    expect(guide.text).toContain('requirements.txt');
    expect(guide.text).toContain('Ce que vous pouvez modifier');
    expect((await request(app).post('/repositories').type('form').send(payload)).status).toBe(409);
    expect(scaffolder.scaffoldRepository).toHaveBeenCalledTimes(1);
});

test('requires public visibility acknowledgement', async () => {
    await request(app).get('/repositories/new');
    expect((await request(app).post('/repositories').type('form').send({ ...input(), publicAcknowledged: '' })).status).toBe(400);
    expect(scaffolder.scaffoldRepository).not.toHaveBeenCalled();
});

test('creation failure preserves input and escapes errors, without a deployment handoff', async () => {
    await request(app).get('/repositories/new');
    scaffolder.scaffoldRepository.mockRejectedValue(new scaffolder.ScaffoldError('<script>failure</script>'));
    const result = await request(app).post('/repositories').type('form').send(input());
    expect(result.status).toBe(400);
    expect(result.text).toContain('value="sample"');
    expect(result.text).toContain('&lt;script&gt;failure');
    expect(result.text).toMatch(/id="repositoryError" class="text-danger"[^>]*>.*&lt;script&gt;failure/);
    expect(result.text.indexOf('id="repositoryError"')).toBeLessThan(result.text.indexOf('>Créer le repo</button>'));
    expect(result.text).not.toContain('/deployments#repository=');
    expect(session.createdRepository).toBeUndefined();
});
