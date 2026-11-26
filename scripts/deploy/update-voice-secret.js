#!/usr/bin/env node
'use strict';

// Publish only voice configuration from a private env file. Keep every other
// application Secret key (OAuth, sessions, GitHub, Datadog, Argo CD) intact.
const fs = require('fs');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/deploy/update-voice-secret.js <private.env>');
  process.exit(2);
}

const source = dotenv.parse(fs.readFileSync(file));
const required = ['SCW_SECRET_KEY', 'REPORT_MODEL_API_KEY', 'VOICE_DEPLOYMENT_ANALYSIS_MODEL'];
const missing = required.filter(key => !source[key]?.trim());
if (missing.length) {
  console.error(`Missing voice configuration: ${missing.join(', ')}`);
  process.exit(2);
}

const optional = ['SCW_DEFAULT_PROJECT_ID', 'VOICE_DEPLOYMENT_GATEWAY_BASE_URL'];
const selected = Object.fromEntries([...required, ...optional]
  .filter(key => source[key]?.trim())
  .map(key => [key, source[key].trim()]));

function kubectl(args, input) {
  const result = spawnSync('kubectl', args, { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'kubectl failed');
  return result.stdout;
}

try {
  const context = kubectl(['config', 'current-context']).trim();
  if (context !== 'gke_cnp-terraform-515922_europe-west9-b_cnp-cluster-terraform') {
    throw new Error(`Unexpected Kubernetes context: ${context}`);
  }
  const current = JSON.parse(kubectl([
    '-n', 'cnp-portal', 'get', 'secret', 'cnp-portal-app-env', '-o', 'json',
  ]));
  const data = { ...current.data };
  for (const [key, value] of Object.entries(selected)) data[key] = Buffer.from(value).toString('base64');
  const secret = {
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'cnp-portal-app-env', namespace: 'cnp-portal',
      resourceVersion: current.metadata.resourceVersion },
    type: 'Opaque', data,
  };
  kubectl(['replace', '-f', '-'], JSON.stringify(secret));
  kubectl(['-n', 'cnp-portal', 'rollout', 'restart', 'deployment/cnp-portal']);
  kubectl(['-n', 'cnp-portal', 'rollout', 'status', 'deployment/cnp-portal', '--timeout=180s']);
  const ready = kubectl(['-n', 'cnp-portal', 'exec', 'deploy/cnp-portal', '--',
    'node', '-e', 'process.exit(require("./src/services/voice-deployment").configured() ? 0 : 1)']);
  void ready;
  console.log('Voice configuration applied; portal rollout and voice readiness passed (values hidden).');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
