'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'Mooroon5-CNP/config-repo' } } }));
jest.mock('../src/clients/github', () => ({
    getRepoOrNull: jest.fn(), createOrgRepo: jest.fn(), listBlobs: jest.fn(), getBlob: jest.fn(),
    commitFiles: jest.fn(), getRef: jest.fn(), createBranch: jest.fn(),
}));

const github = require('../src/clients/github');
const scaffolder = require('../src/services/repo-scaffolder');

const noSleep = async () => {};
const skeletonFiles = {
    'skeletons/_common/README.md': '# {{APP_NAME}} on {{APP_PORT}}',
    'skeletons/node/README.md': '# node override {{APP_NAME}}',
    'skeletons/node/Dockerfile': 'EXPOSE {{APP_PORT}}',
    'skeletons/node/package.json': '{"name":"{{APP_NAME}}"}',
    'skeletons/python/app.py': 'print("python")',
};
const shaOf = path => `sha:${path}`;

beforeEach(() => {
    jest.resetAllMocks();
    github.getRepoOrNull.mockResolvedValue(null);
    github.createOrgRepo.mockResolvedValue({});
    github.listBlobs.mockResolvedValue(Object.keys(skeletonFiles).map(path => ({ path, sha: shaOf(path) })));
    github.getBlob.mockImplementation(async (owner, repo, sha) => Buffer.from(skeletonFiles[sha.slice(4)]));
    github.getRef.mockResolvedValue('main-sha');
    github.commitFiles.mockResolvedValue('commit-sha');
    github.createBranch.mockResolvedValue();
});

const input = { name: 'demo-app', language: 'node', port: 3000 };

test('creates a public repo in the organisation, pushes the rendered skeleton in one commit and creates prod', async () => {
    const result = await scaffolder.scaffoldRepository(input, { sleep: noSleep });

    expect(result).toEqual({ owner: 'Mooroon5-CNP', repo: 'demo-app', url: 'https://github.com/Mooroon5-CNP/demo-app', branches: ['main', 'prod'] });
    expect(github.createOrgRepo).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', expect.objectContaining({ isPrivate: false }));
    expect(github.commitFiles).toHaveBeenCalledTimes(1);
    const [owner, repo, branch, files] = github.commitFiles.mock.calls[0];
    expect([owner, repo, branch]).toEqual(['Mooroon5-CNP', 'demo-app', 'main']);
    const byPath = Object.fromEntries(files.map(f => [f.path, f.content.toString()]));
    expect(byPath['Dockerfile']).toBe('EXPOSE 3000');
    expect(byPath['package.json']).toBe('{"name":"demo-app"}');
    expect(byPath['README.md']).toBe('# node override demo-app');
    expect(Object.keys(byPath).some(p => p.startsWith('skeletons/') || p === 'app.py')).toBe(false);
    expect(JSON.stringify(byPath)).not.toContain('{{');
    expect(github.createBranch).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', 'prod', 'commit-sha');
});

test('the common files are added when the language has none of its own', async () => {
    await scaffolder.scaffoldRepository({ ...input, language: 'python' }, { sleep: noSleep });
    const files = github.commitFiles.mock.calls[0][3];
    expect(files.map(f => f.path).sort()).toEqual(['README.md', 'app.py']);
    expect(files.find(f => f.path === 'README.md').content.toString()).toBe('# demo-app on 3000');
});

test('reads the skeletons from ci-templates, on the configured ref', async () => {
    process.env.CNP_SKELETONS_REF = 'feat/app-skeletons';
    try { await scaffolder.scaffoldRepository(input, { sleep: noSleep }); }
    finally { delete process.env.CNP_SKELETONS_REF; }
    expect(github.listBlobs).toHaveBeenCalledWith('Mooroon5-CNP', 'ci-templates', 'feat/app-skeletons');
});

test('never touches an existing repository', async () => {
    github.getRepoOrNull.mockResolvedValue({ name: 'demo-app' });
    await expect(scaffolder.scaffoldRepository(input, { sleep: noSleep })).rejects.toThrow(/existe déjà/);
    expect(github.createOrgRepo).not.toHaveBeenCalled();
    expect(github.commitFiles).not.toHaveBeenCalled();
});

test('an unreadable skeleton creates nothing', async () => {
    github.listBlobs.mockResolvedValue([]);
    await expect(scaffolder.scaffoldRepository(input, { sleep: noSleep })).rejects.toThrow(/Aucun squelette/);
    expect(github.createOrgRepo).not.toHaveBeenCalled();
});

test.each([
    ['unknown language', { language: 'cobol' }],
    ['inherited object key as language', { language: 'constructor' }],
    ['uppercase name', { name: 'Demo' }],
    ['path traversal', { name: '../config-repo' }],
    ['slash in name', { name: 'org/demo' }],
    ['leading dash', { name: '-demo' }],
    ['one character', { name: 'a' }],
    ['40 characters', { name: 'a'.repeat(40) }],
    ['reserved name', { name: 'config-repo' }],
    ['reserved name ci-templates', { name: 'ci-templates' }],
    ['port zero', { port: 0 }],
    ['port as text', { port: '80; rm' }],
])('rejects %s before calling GitHub', async (_label, override) => {
    await expect(scaffolder.scaffoldRepository({ ...input, ...override }, { sleep: noSleep })).rejects.toBeInstanceOf(scaffolder.ScaffoldError);
    expect(github.getRepoOrNull).not.toHaveBeenCalled();
    expect(github.createOrgRepo).not.toHaveBeenCalled();
});

test('waits for the new repository to be readable before pushing', async () => {
    github.getRef.mockRejectedValueOnce(new Error('Not Found')).mockRejectedValueOnce(new Error('Not Found')).mockResolvedValue('main-sha');
    await scaffolder.scaffoldRepository(input, { sleep: noSleep });
    expect(github.getRef).toHaveBeenCalledTimes(3);
    expect(github.commitFiles).toHaveBeenCalled();
});

test('a partial failure explains where the repo is and keeps it (no deletion)', async () => {
    github.createBranch.mockRejectedValue(new Error('boom'));
    await expect(scaffolder.scaffoldRepository(input, { sleep: noSleep }))
        .rejects.toThrow(/https:\/\/github\.com\/Mooroon5-CNP\/demo-app.*n'est pas supprimé/);
});

test('a failed repository creation says nothing was created (no misleading "kept" message)', async () => {
    github.createOrgRepo.mockRejectedValue(new Error('GitHub App is not allowed to create repositories'));
    const failure = scaffolder.scaffoldRepository(input, { sleep: noSleep });
    await expect(failure).rejects.toThrow(/Impossible de créer le dépôt Mooroon5-CNP\/demo-app.*not allowed/);
    await expect(failure).rejects.not.toThrow(/n'est pas supprimé/);
    expect(github.commitFiles).not.toHaveBeenCalled();
});

test('a push failure after creation keeps the repo and says so', async () => {
    github.commitFiles.mockRejectedValue(new Error('push rejected'));
    await expect(scaffolder.scaffoldRepository(input, { sleep: noSleep })).rejects.toThrow(/Création incomplète.*push rejected.*n'est pas supprimé/);
    expect(github.createBranch).not.toHaveBeenCalled();
});

test('every supported language has a label and the defaults are main + prod', () => {
    expect(Object.keys(scaffolder.LANGUAGES).sort()).toEqual(['cpp', 'fullstack', 'go', 'java', 'node', 'python']);
    expect(scaffolder.DEFAULT_BRANCHES).toEqual(['main', 'prod']);
});
