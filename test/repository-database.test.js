'use strict';

jest.mock('../src/clients/github', () => ({ getInstallationOctokit: jest.fn(), getRef: jest.fn() }));
const fs = require('fs');
const path = require('path');
const github = require('../src/clients/github');
const service = require('../src/services/repository-database');
let files, api;
const repo = { owner: 'team', repo: 'app' };
beforeEach(() => {
  jest.resetAllMocks();
  files = {};
  api = { request: jest.fn(async (_route, args) => {
    if (!(args.path in files)) throw Object.assign(new Error('missing'), { status: 404 });
    return { data: { type: 'file', encoding: 'base64', content: Buffer.from(files[args.path]).toString('base64') } };
  }) };
  github.getInstallationOctokit.mockResolvedValue(api);
  github.getRef.mockResolvedValue('a'.repeat(40));
});

test.each([
  [{ 'package.json': '{"dependencies":{"better-sqlite3":"*"}}' }, 'sqlite'],
  [{ 'package.json': '{"dependencies":{"pg":"*"}}' }, 'postgres'],
  [{ 'requirements.txt': 'Flask>=3\npsycopg[binary]>=3.2,<4' }, 'postgres'],
  [{ 'backend/requirements.txt': 'psycopg2-binary==2.9.10' }, 'postgres'],
  [{ 'app.py': 'import sqlite3\n' }, 'sqlite'],
  [{ 'src/app.py': 'from sqlite3 import connect' }, 'sqlite'],
  [{ 'src/db.js': "const db = require('node:sqlite');" }, 'sqlite'],
  [{ 'src/db.ts': "import postgres from 'postgres';" }, 'postgres'],
  [{ 'prisma/schema.prisma': 'datasource db {\n provider = "postgresql"\n}' }, 'postgres'],
  [{ 'prisma/schema.prisma': 'datasource db {\n provider = "sqlite"\n}' }, 'sqlite'],
])('identifies runtime database in %j', (files, engine) => expect(service.detect(files).engine).toBe(engine));

test('dev dependencies and comments do not establish a runtime database', () => {
  expect(service.detect({ 'package.json': '{"devDependencies":{"better-sqlite3":"*"}}',
    'requirements.txt': '# psycopg[binary]>=3', 'app.py': '# import sqlite3',
    'src/db.js': "// const pg = require('pg')", 'prisma/schema.prisma': '// provider = "sqlite"' }).engine).toBe('unknown');
});

test.each(['sqlite', 'postgres'])('rejects the opposite selected engine for detected %s', async engine => {
  files['package.json'] = JSON.stringify({ dependencies: { [engine === 'sqlite' ? 'better-sqlite3' : 'pg']: '*' } });
  await expect(service.assertCompatible(repo, { environment: 'dev', selected: engine === 'sqlite' ? 'postgres' : 'sqlite' }))
    .rejects.toMatchObject({ code: 'DATABASE_MISMATCH', message: expect.stringContaining('Aucun déploiement n’a été créé') });
  expect(api.request.mock.calls.every(([route]) => route.startsWith('GET '))).toBe(true);
});

test('matching, mixed and unknown engines are allowed', async () => {
  files['package.json'] = '{"dependencies":{"pg":"*"}}';
  expect((await service.assertCompatible(repo, { environment: 'dev', selected: 'postgres' })).engine).toBe('postgres');
  files['package.json'] = '{"dependencies":{"pg":"*","better-sqlite3":"*"}}';
  expect((await service.assertCompatible(repo, { environment: 'dev', selected: 'postgres' })).engine).toBe('mixed');
  files = {};
  expect((await service.assertCompatible(repo, { environment: 'dev', selected: 'sqlite' })).engine).toBe('unknown');
});

test('all file reads use one immutable revision of the selected production branch', async () => {
  await service.assertCompatible(repo, { environment: 'prod', selected: 'sqlite' });
  expect(github.getRef).toHaveBeenCalledWith('team', 'app', 'prod');
  expect(api.request.mock.calls.every(([, args]) => args.ref === 'a'.repeat(40))).toBe(true);
});

test('a missing prod branch uses main, which onboarding will copy', async () => {
  github.getRef.mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }));
  await service.assertCompatible(repo, { environment: 'prod', selected: 'sqlite' });
  expect(github.getRef.mock.calls.map(args => args[2])).toEqual(['prod', 'main']);
});

test('authorization and network failures stop verification without exposing provider details', async () => {
  api.request.mockRejectedValue(Object.assign(new Error('PRIVATE_TOKEN_AND_PROVIDER_BODY'), { status: 403 }));
  await expect(service.assertCompatible(repo, { environment: 'dev', selected: 'sqlite' })).rejects.toThrow('Impossible de vérifier');
  await expect(service.assertCompatible(repo, { environment: 'dev', selected: 'sqlite' })).rejects.not.toThrow('PRIVATE_TOKEN');
});

test('malformed dependency metadata does not silently pass as an unknown engine', async () => {
  files['package.json'] = 'broken json';
  await expect(service.assertCompatible(repo, { environment: 'dev', selected: 'sqlite' })).rejects.toThrow('Impossible de vérifier');
});

test.each(['sqlite', 'postgres'])('detects the bundled Python %s template', engine => {
  const root = path.join(__dirname, '../src/templates/repositories', engine);
  expect(service.detect({ 'app.py': fs.readFileSync(path.join(root, 'app.py'), 'utf8'),
    'requirements.txt': fs.readFileSync(path.join(root, 'requirements.txt'), 'utf8') }).engine).toBe(engine);
});

test('recognizes the actual dancingduck dependency manifest', () => {
  expect(service.detect({ 'package.json': '{"dependencies":{"better-sqlite3":"^12.11.1","express":"^4","winston":"^3"}}' }).engine).toBe('sqlite');
});
