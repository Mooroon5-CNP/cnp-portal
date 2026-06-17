"use strict";

const axios = require('axios');

const GH_API_BASE = 'https://api.github.com';

function defaultHeaders(token) {
    const h = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
}

function parseRepoUrl(url) {
    try {
        const u = new URL(url);
        if (!u.hostname.endsWith('github.com')) return null;
        const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
        if (parts.length < 2) return null;
        const owner = parts[0];
        const repo = parts[1].replace(/\.git$/, '');
        return { owner, repo };
    } catch (e) {
        return null;
    }
}

async function getRepo(repoUrl, token) {
    const p = parseRepoUrl(repoUrl);
    if (!p) throw new Error('Invalid GitHub repo URL');
    const { owner, repo } = p;
    const res = await axios.get(`${GH_API_BASE}/repos/${owner}/${repo}`, { headers: defaultHeaders(token) });
    return res.data;
}

async function getLatestRun(repoUrl, token) {
    const p = parseRepoUrl(repoUrl);
    if (!p) return null;
    const { owner, repo } = p;
    const res = await axios.get(`${GH_API_BASE}/repos/${owner}/${repo}/actions/runs`, {
        headers: defaultHeaders(token),
        params: { per_page: 1, branch: 'main' },
    });
    const runs = res.data && res.data.workflow_runs ? res.data.workflow_runs : [];
    return runs[0] || null;
}

async function getRuns(repoUrl, token, perPage = 5) {
    const p = parseRepoUrl(repoUrl);
    if (!p) return [];
    const { owner, repo } = p;
    const res = await axios.get(`${GH_API_BASE}/repos/${owner}/${repo}/actions/runs`, {
        headers: defaultHeaders(token),
        params: { per_page: perPage, branch: 'main' },
    });
    return (res.data && res.data.workflow_runs) || [];
}

async function getRunJobs(repoUrl, runId, token) {
    const p = parseRepoUrl(repoUrl);
    if (!p) return [];
    const { owner, repo } = p;
    const res = await axios.get(`${GH_API_BASE}/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, {
        headers: defaultHeaders(token),
    });
    return (res.data && res.data.jobs) || [];
}

async function getFileContent(owner, repo, path, token, ref = 'main') {
    // returns raw file content as string
    const res = await axios.get(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
        headers: defaultHeaders(token),
        params: { ref },
    });
    if (res.data && res.data.content) {
        return Buffer.from(res.data.content, 'base64').toString('utf8');
    }
    return null;
}

async function pathExists(owner, repo, path, token, ref = 'main') {
    try {
        await axios.get(`${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`, {
            headers: defaultHeaders(token),
            params: { ref },
        });
        return true;
    } catch (e) {
        return false;
    }
}

// Create or update a file in a repo using a PAT token (e.g. for config-repo writes).
// sha must be provided when updating an existing file; omit for new files.
async function createOrUpdateFileWithToken(owner, repo, path, content, message, token, sha) {
    const body = {
        message,
        content: Buffer.from(content, 'utf8').toString('base64'),
    };
    if (sha) body.sha = sha;
    await axios.put(
        `${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
        body,
        { headers: defaultHeaders(token) }
    );
}

// Get the SHA of an existing file via PAT token. Returns null if not found.
async function getFileSha(owner, repo, path, token) {
    try {
        const res = await axios.get(
            `${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
            { headers: defaultHeaders(token) }
        );
        return res.data.sha || null;
    } catch (e) {
        return null;
    }
}

async function deleteFileWithToken(owner, repo, path, sha, message, token) {
    try {
        await axios.delete(
            `${GH_API_BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
            { headers: defaultHeaders(token), data: { message, sha } }
        );
    } catch (e) {
        if (e.response && e.response.status === 404) return;
        throw e;
    }
}

module.exports = {
    parseRepoUrl,
    getRepo,
    getLatestRun,
    getRuns,
    getRunJobs,
    getFileContent,
    pathExists,
    createOrUpdateFileWithToken,
    getFileSha,
    deleteFileWithToken,
};
