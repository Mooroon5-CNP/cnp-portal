#!/usr/bin/env node
'use strict';

// Rotate only the OAuth client used for browser login. Never print credentials
// or put plaintext credentials into kubectl's last-applied annotation.
const fs = require('fs');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const callback = 'https://cnp-platform.apps.mooroon5.fr/auth/github/callback';
const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/deploy/update-oauth-secret.js <oauth-credentials.env>');
  process.exit(2);
}
const source = dotenv.parse(fs.readFileSync(file));
const clientId = source.GITHUB_CLIENT_ID;
const clientSecret = source.GITHUB_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required.');
  process.exit(2);
}

function kubectl(args, input) {
  const result = spawnSync('kubectl', args, { input, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.error?.message || 'kubectl failed');
  }
  return result.stdout;
}

(async () => {
  // GitHub checks client credentials and registered callback before the code.
  // A deliberately invalid code must therefore yield bad_verification_code.
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret,
      code: 'invalid-cnp-production-callback-check', redirect_uri: callback }),
  });
  const result = await response.json();
  if (result.error !== 'bad_verification_code') {
    throw new Error(`GitHub rejected the OAuth app or callback: ${result.error || response.status}`);
  }

  const context = kubectl(['config', 'current-context']).trim();
  if (context !== 'gke_cnp-terraform-515922_europe-west9-b_cnp-cluster-terraform') {
    throw new Error(`Unexpected Kubernetes context: ${context}`);
  }
  const current = JSON.parse(kubectl([
    '-n', 'cnp-portal', 'get', 'secret', 'cnp-portal-app-env', '-o', 'json',
  ]));
  const data = { ...current.data,
    GITHUB_CLIENT_ID: Buffer.from(clientId).toString('base64'),
    GITHUB_CLIENT_SECRET: Buffer.from(clientSecret).toString('base64'),
    GITHUB_REDIRECT_URI: Buffer.from(callback).toString('base64'),
  };
  const secret = {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'cnp-portal-app-env', namespace: 'cnp-portal',
      resourceVersion: current.metadata.resourceVersion },
    type: 'Opaque', data,
  };
  kubectl(['replace', '-f', '-'], JSON.stringify(secret));
  kubectl(['-n', 'cnp-portal', 'rollout', 'restart', 'deployment/cnp-portal']);
  kubectl(['-n', 'cnp-portal', 'rollout', 'status', 'deployment/cnp-portal', '--timeout=120s']);

  let verified = false;
  for (let attempt = 0; attempt < 10 && !verified; attempt++) {
    try {
      const live = await fetch('https://cnp-platform.apps.mooroon5.fr/auth/github', { redirect: 'manual' });
      const location = live.headers.get('location');
      if (live.status === 302 && location) {
        const authorization = new URL(location);
        verified = authorization.hostname === 'github.com'
          && authorization.searchParams.get('client_id') === clientId
          && authorization.searchParams.get('redirect_uri') === callback;
      }
    } catch (_) { /* ingress can briefly return an error while the pod is replaced */ }
    if (!verified) await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!verified) throw new Error('Live portal OAuth redirect does not match the verified app.');
  console.log('Production OAuth client rotated; GitHub accepted the callback and the live portal uses the new client ID.');
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
