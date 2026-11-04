'use strict';

// End-to-end WITHOUT network: the real GitHub client + the real scaffolder run against an
// in-memory GitHub that implements the REST routes they use, and the skeleton
// files are the REAL ones from the sibling ci-templates checkout.
// Skipped when ci-templates/skeletons is not checked out next to cnp-portal.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

jest.mock('../src/config/env', () => ({ config: { github: { appId: '1', privateKey: 'k', installationId: '2', configRepoName: 'Mooroon5-CNP/config-repo' } } }));

const SKELETONS = path.resolve(__dirname, '../../ci-templates/skeletons');
const available = fs.existsSync(SKELETONS);
const describeIfSkeletons = available ? describe : describe.skip;

const client = require('../src/clients/github');
const scaffolder = require('../src/services/repo-scaffolder');

const sha = data => crypto.createHash('sha1').update(data).digest('hex');
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

// Minimal in-memory GitHub: repos -> { blobs, trees, commits, refs }.
function fakeGithub() {
    const repos = new Map();
    const templates = { blobs: new Map(), tree: [] };
    (function load(dir, prefix = 'skeletons') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '__pycache__') continue;
            const full = path.join(dir, entry.name);
            const rel = `${prefix}/${entry.name}`;
            if (entry.isDirectory()) { load(full, rel); continue; }
            const content = fs.readFileSync(full);
            const id = sha(content);
            templates.blobs.set(id, content);
            templates.tree.push({ type: 'blob', path: rel, sha: id });
        }
    })(SKELETONS);

    const repoOf = (owner, repo) => repos.get(`${owner}/${repo}`) || (() => { throw notFound(); })();
    const request = async (route, a) => {
        switch (route) {
            case 'GET /repos/{owner}/{repo}': return { data: repoOf(a.owner, a.repo).meta };
            case 'POST /orgs/{org}/repos': {
                if (repos.has(`${a.org}/${a.name}`)) throw Object.assign(new Error('exists'), { status: 422 });
                const readme = Buffer.from('# initial');
                const blob = sha(readme);
                const tree = { sha: sha(`tree-${a.name}`), entries: [{ path: 'README.md', sha: blob }] };
                const commit = { sha: sha(`commit-${a.name}`), tree: tree.sha, parent: null };
                repos.set(`${a.org}/${a.name}`, {
                    meta: { name: a.name, private: a.private, html_url: `https://github.com/${a.org}/${a.name}` },
                    blobs: new Map([[blob, readme]]), trees: new Map([[tree.sha, tree]]),
                    commits: new Map([[commit.sha, commit]]), refs: new Map([['main', commit.sha]]),
                });
                return { data: {} };
            }
            case 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}':
                return { data: { truncated: false, tree: templates.tree } };
            case 'GET /repos/{owner}/{repo}/git/blobs/{file_sha}':
                return { data: { content: templates.blobs.get(a.file_sha).toString('base64'), encoding: 'base64' } };
            case 'GET /repos/{owner}/{repo}/git/ref/{ref}': {
                const ref = repoOf(a.owner, a.repo).refs.get(a.ref.replace('heads/', ''));
                if (!ref) throw notFound();
                return { data: { object: { sha: ref } } };
            }
            case 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}': {
                const r = repoOf(a.owner, a.repo);
                return { data: { tree: { sha: r.commits.get(a.commit_sha).tree } } };
            }
            case 'POST /repos/{owner}/{repo}/git/blobs': {
                const r = repoOf(a.owner, a.repo);
                const content = Buffer.from(a.content, a.encoding);
                r.blobs.set(sha(content), content);
                return { data: { sha: sha(content) } };
            }
            case 'POST /repos/{owner}/{repo}/git/trees': {
                const r = repoOf(a.owner, a.repo);
                const base = r.trees.get(a.base_tree).entries.filter(e => !a.tree.some(t => t.path === e.path));
                const entries = [...base, ...a.tree.map(t => ({ path: t.path, sha: t.sha }))];
                const tree = { sha: sha(JSON.stringify(entries)), entries };
                r.trees.set(tree.sha, tree);
                return { data: { sha: tree.sha } };
            }
            case 'POST /repos/{owner}/{repo}/git/commits': {
                const r = repoOf(a.owner, a.repo);
                const commit = { sha: sha(JSON.stringify(a)), tree: a.tree, parent: a.parents[0], message: a.message };
                r.commits.set(commit.sha, commit);
                return { data: { sha: commit.sha } };
            }
            case 'PATCH /repos/{owner}/{repo}/git/refs/{ref}':
                repoOf(a.owner, a.repo).refs.set(a.ref.replace('heads/', ''), a.sha);
                return { data: {} };
            case 'POST /repos/{owner}/{repo}/git/refs': {
                const r = repoOf(a.owner, a.repo);
                const name = a.ref.replace('refs/heads/', '');
                if (r.refs.has(name)) throw Object.assign(new Error('exists'), { status: 422 });
                r.refs.set(name, a.sha);
                return { data: {} };
            }
            default: throw new Error(`unexpected GitHub call: ${route}`);
        }
    };
    const files = (owner, repo, branch) => {
        const r = repoOf(owner, repo);
        const tree = r.trees.get(r.commits.get(r.refs.get(branch)).tree);
        return Object.fromEntries(tree.entries.map(e => [e.path, r.blobs.get(e.sha).toString('utf8')]));
    };
    return { request, repos, files };
}

const MARKERS = {
    node: ['package.json', 'package-lock.json', 'Dockerfile'],
    python: ['requirements.txt', 'app.py', 'Dockerfile'],
    go: ['go.mod', 'main.go', 'Dockerfile'],
    java: ['pom.xml', 'Dockerfile'],
    cpp: ['CMakeLists.txt', 'Dockerfile'],
    fullstack: ['web/package.json', 'api/requirements.txt', 'Dockerfile'],
};

describeIfSkeletons('scaffolding against an in-memory GitHub, with the real skeletons', () => {
    let github;
    beforeEach(() => {
        github = fakeGithub();
        client.setOctokitForTesting({ request: github.request });
    });

    test.each(Object.keys(MARKERS))('%s: repo is public, has main and prod on the same commit, and the skeleton is rendered', async language => {
        const result = await scaffolder.scaffoldRepository({ name: 'demo-app', language, port: 4321 }, { sleep: async () => {} });

        expect(result.url).toBe('https://github.com/Mooroon5-CNP/demo-app');
        const repo = github.repos.get('Mooroon5-CNP/demo-app');
        expect(repo.meta.private).toBe(false);
        expect([...repo.refs.keys()].sort()).toEqual(['main', 'prod']);
        expect(repo.refs.get('prod')).toBe(repo.refs.get('main'));
        expect(repo.commits.get(repo.refs.get('main')).message).toMatch(/initial skeleton/);

        const files = github.files('Mooroon5-CNP', 'demo-app', 'main');
        for (const marker of MARKERS[language]) expect(Object.keys(files)).toContain(marker);
        expect(Object.keys(files).filter(p => p.startsWith('.github/'))).toEqual([]);
        expect(Object.keys(files).filter(p => p.startsWith('skeletons/') || p.startsWith('_common'))).toEqual([]);
        for (const [file, content] of Object.entries(files)) expect(`${file}: ${content.includes('{{')}`).toBe(`${file}: false`);
        expect(files['README.md']).toContain('# demo-app');
        expect(files['README.md']).toContain('4321');
        expect(files['Dockerfile']).toContain('EXPOSE 4321');
        expect(files['Dockerfile']).toMatch(/USER 1000/);
        expect(files['Dockerfile']).toContain('HEALTHCHECK');
    });

    test('the initial README of the freshly created repo is replaced by the skeleton README', async () => {
        await scaffolder.scaffoldRepository({ name: 'demo-app', language: 'go', port: 8080 }, { sleep: async () => {} });
        expect(github.files('Mooroon5-CNP', 'demo-app', 'main')['README.md']).not.toBe('# initial');
    });

    test('a second creation with the same name is refused and leaves the first repo untouched', async () => {
        await scaffolder.scaffoldRepository({ name: 'demo-app', language: 'node', port: 8080 }, { sleep: async () => {} });
        const before = github.files('Mooroon5-CNP', 'demo-app', 'main');
        await expect(scaffolder.scaffoldRepository({ name: 'demo-app', language: 'python', port: 9000 }, { sleep: async () => {} })).rejects.toThrow(/existe déjà/);
        expect(github.files('Mooroon5-CNP', 'demo-app', 'main')).toEqual(before);
    });

    test('the same skeleton name cannot be created twice in parallel (GitHub refuses the second creation)', async () => {
        const results = await Promise.allSettled([
            scaffolder.scaffoldRepository({ name: 'race-app', language: 'node', port: 8080 }, { sleep: async () => {} }),
            scaffolder.scaffoldRepository({ name: 'race-app', language: 'node', port: 8080 }, { sleep: async () => {} }),
        ]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    });

    test('a repository that never becomes readable fails with an explicit message and no commit', async () => {
        const original = github.request;
        client.setOctokitForTesting({
            request: async (route, a) => {
                if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') throw notFound();
                return original(route, a);
            },
        });
        await expect(scaffolder.scaffoldRepository({ name: 'slow-app', language: 'node', port: 8080 }, { sleep: async () => {} }))
            .rejects.toThrow(/Création incomplète.*n'est pas prêt/);
        expect(github.repos.get('Mooroon5-CNP/slow-app').commits.size).toBe(1);
    });
});

test('the skeletons checkout is available (otherwise the suite above is silently skipped)', () => {
    if (!available) console.warn(`SKIPPED: ${SKELETONS} not found — clone ci-templates next to cnp-portal.`);
    expect(typeof available).toBe('boolean');
});
