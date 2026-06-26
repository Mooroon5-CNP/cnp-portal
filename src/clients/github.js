'use strict';

const { config } = require('../config/env');

let _octokit = null;

async function getInstallationOctokit() {
  if (_octokit) return _octokit;

  if (!config.github.appId || !config.github.privateKey || !config.github.installationId) {
    throw new Error('GitHub App credentials not configured (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID)');
  }

  const { createAppAuth } = await import('@octokit/auth-app');
  const { Octokit } = await import('@octokit/rest');

  _octokit = new Octokit({ authStrategy: createAppAuth, auth: {
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    installationId: config.github.installationId,
  }});

  return _octokit;
}

async function setRepoSecret(owner, repo, secretName, secretValue) {
  const octokit = await getInstallationOctokit();

  let publicKeyData;
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', { owner, repo });
    publicKeyData = data;
  } catch (err) {
    if (err.status === 401) { _octokit = null; throw new Error('GitHub App authentication failed. Check GITHUB_APP_PRIVATE_KEY and GITHUB_APP_ID.'); }
    if (err.status === 404) throw new Error(`Repository ${owner}/${repo} not found or GitHub App has no access.`);
    throw new Error(`Failed to fetch public key for ${owner}/${repo}: ${err.message}`);
  }

  const sodium = require('libsodium-wrappers');
  await sodium.ready;

  const keyBytes = Buffer.from(publicKeyData.key, 'base64');
  const secretBytes = Buffer.from(secretValue, 'utf-8');
  const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
  const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

  try {
    await octokit.request('PUT /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
      owner,
      repo,
      secret_name: secretName,
      encrypted_value: encryptedValue,
      key_id: publicKeyData.key_id,
    });
  } catch (err) {
    if (err.status === 404) throw new Error(`Repository ${owner}/${repo} not found or GitHub App lacks Actions write permission.`);
    if (err.status === 401) throw new Error('GitHub App authentication failed when writing secret.');
    throw new Error(`Failed to set secret ${secretName} on ${owner}/${repo}: ${err.message}`);
  }
}

// Create or update a file in a repo via GitHub App auth.
// sha must be provided when updating an existing file.
async function createOrUpdateFile(owner, repo, path, content, message, sha) {
  const octokit = await getInstallationOctokit();
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
  };
  if (sha) body.sha = sha;
  try {
    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path, ...body,
    });
  } catch (err) {
    if (err.status === 401) _octokit = null;
    throw new Error(`Failed to create/update ${path} in ${owner}/${repo}: ${err.message}`);
  }
}

// Get the SHA of a specific file via GitHub App auth. Returns null if not found.
async function getFileSha(owner, repo, path) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path,
    });
    return data.sha || null;
  } catch (e) {
    return null;
  }
}

// Get the SHA of a branch HEAD via GitHub App auth.
async function getRef(owner, repo, branch) {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
    owner, repo, ref: `heads/${branch}`,
  });
  return data.object.sha;
}

// Create a new branch from an existing SHA via GitHub App auth.
// Silently succeeds if branch already exists (422).
async function createBranch(owner, repo, branchName, sha) {
  const octokit = await getInstallationOctokit();
  try {
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner, repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
  } catch (err) {
    if (err.status === 422) return; // branch already exists
    throw new Error(`Failed to create branch ${branchName} in ${owner}/${repo}: ${err.message}`);
  }
}

// Get the latest workflow run on main via GitHub App auth.
async function getLatestRun(owner, repo) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner, repo, per_page: 1, branch: 'main',
    });
    return (data.workflow_runs || [])[0] || null;
  } catch (e) {
    return null;
  }
}

// Get the last N workflow runs via GitHub App auth.
async function getRuns(owner, repo, perPage = 5) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner, repo, per_page: perPage,
    });
    return data.workflow_runs || [];
  } catch (e) {
    return [];
  }
}

// Get jobs for a specific run via GitHub App auth.
async function getRunJobs(owner, repo, runId) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
      owner, repo, run_id: runId,
    });
    return data.jobs || [];
  } catch (e) {
    return [];
  }
}

// Delete a file from a repo via GitHub App auth.
async function deleteFile(owner, repo, path, sha, message) {
  const octokit = await getInstallationOctokit();
  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path,
      message,
      sha,
    });
  } catch (err) {
    if (err.status === 404) return; // already gone
    throw new Error(`Failed to delete ${path} in ${owner}/${repo}: ${err.message}`);
  }
}

// Create or update an Actions variable (non-secret) on a repo via GitHub App auth.
async function setRepoVariable(owner, repo, variableName, variableValue) {
  const octokit = await getInstallationOctokit();
  try {
    // Try PATCH first (update existing), fall back to POST (create new)
    await octokit.request('PATCH /repos/{owner}/{repo}/actions/variables/{name}', {
      owner, repo, name: variableName, value: variableValue,
    });
  } catch (err) {
    if (err.status === 404) {
      await octokit.request('POST /repos/{owner}/{repo}/actions/variables', {
        owner, repo, name: variableName, value: variableValue,
      });
    } else {
      throw new Error(`Failed to set variable ${variableName} on ${owner}/${repo}: ${err.message}`);
    }
  }
}

// Delete an Actions secret from a repo via GitHub App auth.
async function deleteSecret(owner, repo, secretName) {
  const octokit = await getInstallationOctokit();
  try {
    await octokit.request('DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}', {
      owner, repo, secret_name: secretName,
    });
  } catch (err) {
    if (err.status === 404) return; // already gone
    throw new Error(`Failed to delete secret ${secretName} from ${owner}/${repo}: ${err.message}`);
  }
}

// Verify that GitHub Actions is enabled on a repo by probing the secrets
// public-key endpoint. Throws if Actions is disabled (404) or App lacks access.
async function checkActionsEnabled(owner, repo) {
  const octokit = await getInstallationOctokit();
  try {
    await octokit.request('GET /repos/{owner}/{repo}/actions/secrets/public-key', { owner, repo });
  } catch (err) {
    if (err.status === 404) {
      throw new Error(`GitHub Actions is disabled on ${owner}/${repo}. Enable it in the repo's Settings → Actions → General.`);
    }
    if (err.status === 401) { _octokit = null; throw new Error('GitHub App authentication failed.'); }
    throw err;
  }
}

async function checkConnectivity() {
  const octokit = await getInstallationOctokit();
  await octokit.request('GET /app');
}

module.exports = {
  getInstallationOctokit,
  setRepoSecret,
  createOrUpdateFile,
  getFileSha,
  getRef,
  createBranch,
  getLatestRun,
  getRuns,
  getRunJobs,
  deleteFile,
  setRepoVariable,
  deleteSecret,
  checkActionsEnabled,
  checkConnectivity,
};
