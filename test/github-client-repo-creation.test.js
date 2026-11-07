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
        await expect(client.getRepoOrNull('org', 'demo')).rejects.toThrow(/Failed to look up org\/demo/);
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
        [422, /already exists/],
        [403, /Administration: write/],
        [404, /Administration: write/],
        [500, /Failed to create repository org\/demo/],
    ])('maps HTTP %i to an actionable message', async (status, message) => {
        mockRequest.mockRejectedValue(httpError(status));
        await expect(client.createOrgRepo('org', 'demo')).rejects.toThrow(message);
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
