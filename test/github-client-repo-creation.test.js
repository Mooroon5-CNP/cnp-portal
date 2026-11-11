'use strict';

// The octokit instance is faked (setOctokitForTesting): these tests pin the exact GitHub REST calls
// the scaffolder relies on (routes, payloads, error mapping).

const mockRequest = jest.fn();
jest.mock('../src/config/env', () => ({ config: { github: { appId: '1', privateKey: 'key', installationId: '2' } } }));

const client = require('../src/clients/github');

const httpError = (status, message = 'http error') => Object.assign(new Error(message), { status });
const calls = route => mockRequest.mock.calls.filter(([r]) => r === route);

beforeEach(() => {
    mockRequest.mockReset();
    // A 401 resets the cached client on purpose, so inject the fake again for each test.
    client.setOctokitForTesting({ request: mockRequest });
});

describe('getRepoOrNull', () => {
    test('returns the repository when it exists', async () => {
        mockRequest.mockResolvedValue({ data: { name: 'demo' } });
        await expect(client.getRepoOrNull('org', 'demo')).resolves.toEqual({ name: 'demo' });
        expect(mockRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}', { owner: 'org', repo: 'demo' });
    });
    test('returns null on 404 (free name)', async () => {
        mockRequest.mockRejectedValue(httpError(404));
        await expect(client.getRepoOrNull('org', 'demo')).resolves.toBeNull();
    });
    test.each([401, 403, 500])('does not hide a %i as "free name"', async status => {
        mockRequest.mockRejectedValue(httpError(status));
        await expect(client.getRepoOrNull('org', 'demo')).rejects.toThrow(/Impossible de vérifier le repo org\/demo/);
    });
});

test('sets main as the default branch of a newly created repository', async () => {
    mockRequest.mockResolvedValue({ data: {} });
    await client.setDefaultBranch('org', 'demo', 'main');
    expect(mockRequest).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}', {
        owner: 'org', repo: 'demo', default_branch: 'main',
    });
});

describe('createOrgRepo', () => {
    test('creates the repository in the organisation with an initial commit', async () => {
        mockRequest.mockResolvedValue({ data: { html_url: 'https://github.com/org/demo' } });
        await client.createOrgRepo('org', 'demo', { description: 'd', isPrivate: false });
        expect(mockRequest).toHaveBeenCalledWith('POST /orgs/{org}/repos', { org: 'org', name: 'demo', description: 'd', private: false, auto_init: true });
    });
    test('is private only when asked', async () => {
        mockRequest.mockResolvedValue({ data: {} });
        await client.createOrgRepo('org', 'demo', { isPrivate: true });
        expect(mockRequest.mock.calls[0][1].private).toBe(true);
    });
    test.each([
        [422, /existe déjà/],
        [403, /Administration: write/],
        [404, /Administration: write/],
        [500, /Impossible de créer le repo org\/demo/],
    ])('maps HTTP %i to an actionable message', async (status, message) => {
        mockRequest.mockRejectedValue(httpError(status));
        await expect(client.createOrgRepo('org', 'demo')).rejects.toThrow(message);
    });
});

describe('dispatchWorkflow', () => {
    const yaml = require('js-yaml');
    const workflow = dispatch => ({
        on: { push: { branches: ['main', 'prod'] }, ...(dispatch ? { workflow_dispatch: {} } : {}) },
        permissions: { contents: 'read' },
        jobs: { pipeline: { uses: 'Mooroon5-CNP/ci-templates/.github/workflows/pipeline.yml@main', with: { app_name: 'demo', gitops_mode: 'portal' } } },
    });
    function respond(dispatch, app = 'demo') {
        mockRequest.mockImplementation(async (route) => {
            if (route === 'GET /repos/{owner}/{repo}') return { data: { default_branch: 'main' } };
            if (route.startsWith('GET /repos/{owner}/{repo}/contents')) {
                const document = workflow(dispatch);
                document.jobs.pipeline.with.app_name = app;
                return { data: { sha: 'file-sha', content: Buffer.from(yaml.dump(document)).toString('base64') } };
            }
            return { data: {} };
        });
    }
    test('dispatches prod by branch name without replaying the old SHA or rewriting configured workflows', async () => {
        respond(true);
        await client.dispatchWorkflow('org', 'demo', 'cnp-demo.yml', 'prod', 'demo');
        expect(calls('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches')[0][1]).toEqual({ owner: 'org', repo: 'demo', workflow_id: 'cnp-demo.yml', ref: 'prod' });
        expect(calls('PUT /repos/{owner}/{repo}/contents/{path}')).toHaveLength(0);
    });
    test('upgrades existing workflows on main and prod, preserving jobs and push triggers', async () => {
        respond(false);
        await client.dispatchWorkflow('org', 'demo', 'cnp-demo.yml', 'prod', 'demo');
        const updates = calls('PUT /repos/{owner}/{repo}/contents/{path}');
        expect(updates.map(([, args]) => args.branch)).toEqual(['main', 'prod']);
        for (const [, args] of updates) {
            const updated = yaml.load(Buffer.from(args.content, 'base64').toString());
            expect(updated.jobs).toEqual(workflow(false).jobs);
            expect(updated.on.push).toEqual(workflow(false).on.push);
            expect(updated.on.workflow_dispatch).toEqual({});
            expect(args.message).toContain('[skip ci]');
        }
    });
    test('never changes an unrelated workflow or dispatches it', async () => {
        respond(false, 'another-app');
        await expect(client.dispatchWorkflow('org', 'demo', 'cnp-demo.yml', 'main', 'demo')).rejects.toThrow('reconnu');
        expect(mockRequest.mock.calls.every(([route]) => route.startsWith('GET '))).toBe(true);
    });
    test('dispatch permission errors explicitly request Actions write without exposing credentials', async () => {
        respond(true);
        const respondNormally = mockRequest.getMockImplementation();
        mockRequest.mockImplementation((route, args) => {
            if (route.endsWith('/dispatches')) throw Object.assign(new Error('sensitive upstream detail'), { status: 403 });
            return respondNormally(route, args);
        });
        await expect(client.dispatchWorkflow('org', 'demo', 'cnp-demo.yml', 'main', 'demo')).rejects.toMatchObject({
            userMessage: expect.stringContaining('Actions : lecture et écriture'),
            message: expect.not.stringContaining('sensitive upstream detail'),
        });
    });
});

describe('listBlobs / getBlob', () => {
    test('lists only blobs of the recursive tree', async () => {
        mockRequest.mockResolvedValue({ data: { truncated: false, tree: [
            { type: 'tree', path: 'skeletons', sha: 't' }, { type: 'blob', path: 'skeletons/a', sha: 'a', mode: '1' },
        ] } });
        await expect(client.listBlobs('org', 'ci-templates', 'main')).resolves.toEqual([{ path: 'skeletons/a', sha: 'a' }]);
        expect(mockRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', { owner: 'org', repo: 'ci-templates', tree_sha: 'main', recursive: '1' });
    });
    test('refuses a truncated tree instead of pushing a partial skeleton', async () => {
        mockRequest.mockResolvedValue({ data: { truncated: true, tree: [] } });
        await expect(client.listBlobs('org', 'ci-templates', 'main')).rejects.toThrow(/too large/);
    });
    test('decodes base64 blobs', async () => {
        mockRequest.mockResolvedValue({ data: { content: Buffer.from('héllo').toString('base64'), encoding: 'base64' } });
        expect((await client.getBlob('org', 'r', 'sha')).toString('utf8')).toBe('héllo');
    });
    test('accepts utf-8 blobs', async () => {
        mockRequest.mockResolvedValue({ data: { content: 'plain', encoding: 'utf-8' } });
        expect((await client.getBlob('org', 'r', 'sha')).toString()).toBe('plain');
    });
});

describe('commitFiles', () => {
    test('pushes all files as ONE commit on top of the branch, without forcing', async () => {
        mockRequest.mockImplementation(async (route, args) => {
            if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') return { data: { object: { sha: 'parent' } } };
            if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') return { data: { tree: { sha: 'base-tree' } } };
            if (route === 'POST /repos/{owner}/{repo}/git/blobs') return { data: { sha: `blob-${Buffer.from(args.content, 'base64')}` } };
            if (route === 'POST /repos/{owner}/{repo}/git/trees') return { data: { sha: 'new-tree' } };
            if (route === 'POST /repos/{owner}/{repo}/git/commits') return { data: { sha: 'new-commit' } };
            return { data: {} };
        });

        const sha = await client.commitFiles('org', 'demo', 'main', [
            { path: 'a.txt', content: Buffer.from('A') }, { path: 'dir/b.txt', content: Buffer.from('B') },
        ], 'msg');

        expect(sha).toBe('new-commit');
        expect(calls('POST /repos/{owner}/{repo}/git/blobs')).toHaveLength(2);
        expect(calls('POST /repos/{owner}/{repo}/git/commits')).toHaveLength(1);
        expect(calls('POST /repos/{owner}/{repo}/git/trees')[0][1].tree).toEqual([
            { path: 'a.txt', mode: '100644', type: 'blob', sha: 'blob-A' },
            { path: 'dir/b.txt', mode: '100644', type: 'blob', sha: 'blob-B' },
        ]);
        expect(calls('POST /repos/{owner}/{repo}/git/trees')[0][1].base_tree).toBe('base-tree');
        expect(calls('POST /repos/{owner}/{repo}/git/commits')[0][1]).toMatchObject({ message: 'msg', tree: 'new-tree', parents: ['parent'] });
        expect(calls('PATCH /repos/{owner}/{repo}/git/refs/{ref}')[0][1]).toMatchObject({ ref: 'heads/main', sha: 'new-commit', force: false });
    });
});
