'use strict';

jest.mock('../src/config/env', () => ({ config: { github: { configRepoName: 'Mooroon5-CNP/config-repo' } } }));
jest.mock('../src/clients/github', () => ({
    getRepoOrNull: jest.fn(), createOrgRepo: jest.fn(), commitFiles: jest.fn(), getRef: jest.fn(), createBranch: jest.fn(), setDefaultBranch: jest.fn(),
}));
const github = require('../src/clients/github');
const scaffolder = require('../src/services/repo-scaffolder');
const input = { name: 'demo-app', template: 'sqlite', port: 8080 };
const options = { sleep: async () => {} };

beforeEach(() => {
    jest.resetAllMocks();
    github.getRepoOrNull.mockResolvedValue(null);
    github.createOrgRepo.mockResolvedValue({ default_branch: 'main' });
    github.getRef.mockResolvedValue('initial');
    github.commitFiles.mockResolvedValue('skeleton');
});

test.each(['sqlite', 'postgres'])('creates the actual %s template without CI or cloud manifests', async template => {
    const repository = await scaffolder.scaffoldRepository({ ...input, template }, options);
    expect(repository).toMatchObject({ template, url: 'https://github.com/Mooroon5-CNP/demo-app' });
    expect(github.createOrgRepo).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', expect.objectContaining({ isPrivate: false }));
    const files = Object.fromEntries(github.commitFiles.mock.calls[0][3].map(file => [file.path, file.content.toString()]));
    expect(files['app.py']).toContain(template === 'sqlite' ? 'sqlite3.connect' : 'psycopg.connect');
    expect(files['app.py']).toContain('demo-app');
    expect(files.Dockerfile).toContain('EXPOSE 8080');
    expect(files['requirements.txt']).toContain('Flask');
    expect(Object.keys(files).sort()).toEqual(['.dockerignore', '.flake8', '.gitignore', 'Dockerfile', 'README.md', 'app.py', 'requirements.txt', 'test_app.py']);
    expect(JSON.stringify(files)).not.toContain('{{');
    expect(github.createBranch).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', 'prod', 'skeleton');
});

test.each([
    { name: '../escape' }, { name: 'config-repo' }, { name: 'A' },
    { template: 'constructor' }, { template: '../postgres' }, { port: 0 }, { port: 1.5 },
    { description: 'x'.repeat(351) },
])('invalid input never reaches GitHub: %j', async override => {
    await expect(scaffolder.scaffoldRepository({ ...input, ...override }, options)).rejects.toBeInstanceOf(scaffolder.ScaffoldError);
    expect(github.getRepoOrNull).not.toHaveBeenCalled();
});

test('never overwrites an existing repository', async () => {
    github.getRepoOrNull.mockResolvedValue({ name: input.name });
    await expect(scaffolder.scaffoldRepository(input, options)).rejects.toThrow('existe déjà');
    expect(github.commitFiles).not.toHaveBeenCalled();
    expect(github.createOrgRepo).not.toHaveBeenCalled();
});

test('handles an organisation whose default branch is not main', async () => {
    github.createOrgRepo.mockResolvedValue({ default_branch: 'master' });
    await scaffolder.scaffoldRepository(input, options);
    expect(github.getRef).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', 'master');
    expect(github.createBranch).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', 'main', 'initial');
    expect(github.setDefaultBranch).toHaveBeenCalledWith('Mooroon5-CNP', 'demo-app', 'main');
});

test('preserves a partially created repository and explains recovery', async () => {
    github.commitFiles.mockRejectedValue(new Error('permission denied'));
    await expect(scaffolder.scaffoldRepository(input, options)).rejects.toThrow(/Création incomplète.*https:.*n'est pas supprimé/);
});

test('bounded readiness retries do not push into an unreadable repository', async () => {
    github.getRef.mockRejectedValue(new Error('not ready'));
    await expect(scaffolder.scaffoldRepository(input, options)).rejects.toThrow('Création incomplète');
    expect(github.getRef).toHaveBeenCalledTimes(6);
    expect(github.commitFiles).not.toHaveBeenCalled();
});
