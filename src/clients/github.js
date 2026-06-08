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

  const auth = createAppAuth({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    installationId: config.github.installationId,
  });

  _octokit = new Octokit({ authStrategy: createAppAuth, auth: {
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    installationId: config.github.installationId,
  }});

  return _octokit;
}

async function setRepoSecret(owner, repo, secretName, secretValue) {
  const octokit = await getInstallationOctokit();

  // 1. Fetch the repo's public key for secret encryption
  let publicKeyData;
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/public-key', { owner, repo });
    publicKeyData = data;
  } catch (err) {
    if (err.status === 404) throw new Error(`Repository ${owner}/${repo} not found or GitHub App has no access.`);
    if (err.status === 401) throw new Error('GitHub App authentication failed. Check GITHUB_APP_PRIVATE_KEY and GITHUB_APP_ID.');
    throw new Error(`Failed to fetch public key for ${owner}/${repo}: ${err.message}`);
  }

  // 2. Encrypt the secret value with libsodium sealed box
  const sodium = require('libsodium-wrappers');
  await sodium.ready;

  const keyBytes = Buffer.from(publicKeyData.key, 'base64');
  const secretBytes = Buffer.from(secretValue, 'utf-8');
  const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
  const encryptedValue = Buffer.from(encryptedBytes).toString('base64');

  // 3. Push the encrypted secret
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

async function checkConnectivity() {
  const octokit = await getInstallationOctokit();
  await octokit.request('GET /app');
}

module.exports = { getInstallationOctokit, setRepoSecret, checkConnectivity };
