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
async function getLatestRun(owner, repo, branch = 'main', workflowId = null) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request(workflowId ? 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs' : 'GET /repos/{owner}/{repo}/actions/runs', {
      owner, repo, per_page: 1, branch, ...(workflowId ? { workflow_id: workflowId } : {}),
    });
    return (data.workflow_runs || [])[0] || null;
  } catch (e) {
    return null;
  }
}

// Get the last N workflow runs via GitHub App auth.
async function getRuns(owner, repo, perPage = 5, branch = 'main', workflowId = null) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request(workflowId ? 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs' : 'GET /repos/{owner}/{repo}/actions/runs', {
      owner, repo, per_page: perPage, branch, ...(workflowId ? { workflow_id: workflowId } : {}),
    });
    return data.workflow_runs || [];
  } catch (e) {
    return [];
  }
}

// Start a new run on the current branch head; never reuse an old run's SHA.
async function dispatchWorkflow(owner, repo, workflowId, branch, appName) {
  const octokit = await getInstallationOctokit();
  const yaml = require('js-yaml');
  const { data: repository } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
  const path = `.github/workflows/${workflowId}`;
  const updates = [];
  // GitHub requires dispatch support on the default branch as well as the selected ref.
  for (const ref of new Set([repository.default_branch || 'main', branch])) {
    const { data: file } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path, ref });
    const workflow = yaml.load(Buffer.from(file.content, 'base64').toString('utf8'));
    const caller = workflow?.jobs?.pipeline;
    if (!caller?.uses?.startsWith('Mooroon5-CNP/ci-templates/') || caller.with?.app_name !== appName) {
      throw new Error('Ce workflow n’est pas un workflow CNP reconnu. Contactez l’équipe plateforme.');
    }
    let triggers = workflow.on;
    if (typeof triggers === 'string') triggers = { [triggers]: null };
    if (Array.isArray(triggers)) triggers = Object.fromEntries(triggers.map(trigger => [trigger, null]));
    if (!triggers || typeof triggers !== 'object') throw new Error('Déclencheurs du workflow invalides.');
    if (!Object.prototype.hasOwnProperty.call(triggers, 'workflow_dispatch')) {
      workflow.on = { ...triggers, workflow_dispatch: {} };
      updates.push({ branch: ref, sha: file.sha, content: Buffer.from(yaml.dump(workflow, { lineWidth: -1 })).toString('base64') });
    }
  }
  for (const update of updates) {
    await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner, repo, path, ...update, message: `ci(${appName}): enable manual pipeline [skip ci]`,
    });
  }
  try {
    await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
      owner, repo, workflow_id: workflowId, ref: branch,
    });
  } catch (error) {
    let userMessage;
    if (error.status === 403) {
      userMessage = 'GitHub refuse le lancement de la pipeline : la GitHub App doit disposer de la permission Actions : lecture et écriture sur ce repo. Faites approuver cette permission dans l’installation de l’organisation, puis réessayez.';
    } else if (error.status === 404) {
      userMessage = 'GitHub ne trouve pas le workflow à lancer. Vérifiez sa présence sur la branche par défaut et l’accès de la GitHub App au repo.';
    } else if (error.status === 422) {
      userMessage = 'GitHub refuse le déclenchement : vérifiez que la branche existe et que le workflow autorise workflow_dispatch.';
    }
    if (userMessage) throw Object.assign(new Error(userMessage), { userMessage });
    throw error;
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

// Get a repository, or null when it does not exist (or is invisible to the App).
async function getRepoOrNull(owner, repo) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    return data;
  } catch (err) {
    if (err.status === 404) return null;
    if (err.status === 401) _octokit = null;
    throw new Error(`Impossible de vérifier le repo ${owner}/${repo} : ${err.message}`);
  }
}

// Create a repository in an organisation, with an initial commit on the default
// branch (needed so the Git Data API can push on top of it).
async function createOrgRepo(org, name, { description = '', isPrivate = false } = {}) {
  const octokit = await getInstallationOctokit();
  try {
    const { data } = await octokit.request('POST /orgs/{org}/repos', {
      org, name, description, private: isPrivate, auto_init: true,
    });
    return data;
  } catch (err) {
    if (err.status === 401) _octokit = null;
    if (err.status === 422) throw new Error(`Le repo ${org}/${name} existe déjà ou son nom est refusé par GitHub.`);
    if (err.status === 403 || err.status === 404) {
      throw new Error(`La GitHub App ne peut pas créer de repos dans ${org} (permission Administration: write et accès de l’installation requis).`);
    }
    throw new Error(`Impossible de créer le repo ${org}/${name} : ${err.message}`);
  }
}

// Used only when a newly created repository starts on another default branch.
async function setDefaultBranch(owner, repo, branch) {
  const octokit = await getInstallationOctokit();
  await octokit.request('PATCH /repos/{owner}/{repo}', { owner, repo, default_branch: branch });
}

// List the blobs of a tree (recursive) at a ref, as [{ path, sha }].
async function listBlobs(owner, repo, ref) {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
    owner, repo, tree_sha: ref, recursive: '1',
  });
  if (data.truncated) throw new Error(`Tree of ${owner}/${repo}@${ref} is too large to be read in one call.`);
  return data.tree.filter(entry => entry.type === 'blob').map(({ path, sha }) => ({ path, sha }));
}

// Read a blob as a Buffer.
async function getBlob(owner, repo, sha) {
  const octokit = await getInstallationOctokit();
  const { data } = await octokit.request('GET /repos/{owner}/{repo}/git/blobs/{file_sha}', { owner, repo, file_sha: sha });
  return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf8');
}

// Push several files as ONE commit on top of a branch (Git Data API).
// files: [{ path, content: Buffer }]. Returns the new commit SHA.
async function commitFiles(owner, repo, branch, files, message) {
  const octokit = await getInstallationOctokit();
  const parentSha = await getRef(owner, repo, branch);
  const { data: parent } = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
    owner, repo, commit_sha: parentSha,
  });
  const tree = [];
  for (const file of files) {
    const { data: blob } = await octokit.request('POST /repos/{owner}/{repo}/git/blobs', {
      owner, repo, content: file.content.toString('base64'), encoding: 'base64',
    });
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const { data: newTree } = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
    owner, repo, base_tree: parent.tree.sha, tree,
  });
  const { data: commit } = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
    owner, repo, message, tree: newTree.sha, parents: [parentSha],
  });
  await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
    owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false,
  });
  return commit.sha;
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
  dispatchWorkflow,
  deleteFile,
  setRepoVariable,
  deleteSecret,
  checkActionsEnabled,
  setOctokitForTesting: octokit => { if (process.env.NODE_ENV !== 'test') throw new Error('Test only'); _octokit = octokit; },
  getRepoOrNull,
  createOrgRepo,
  setDefaultBranch,
  listBlobs,
  getBlob,
  commitFiles,
  checkConnectivity,
};
