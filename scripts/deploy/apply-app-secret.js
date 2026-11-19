#!/usr/bin/env node
'use strict';

// Apply only the portal's application credentials. Platform credentials are
// supplied by Terraform in cnp-portal-cloud-env and must not be imported here.
const fs = require('fs');
const { randomBytes } = require('crypto');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/deploy/apply-app-secret.js <credentials.env>');
  process.exit(2);
}

const source = dotenv.parse(fs.readFileSync(file));
const required = [
  'ADMIN_INITIAL_PASSWORD',
  'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_CONFIG_REPO_NAME', 'DD_API_KEY', 'DD_APP_KEY',
];
const optional = [
  'GITHUB_CONFIG_REPO_TOKEN', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'DD_SITE',
];
const missing = required.filter(key => !source[key]);
if (missing.length) {
  console.error(`Missing required application keys: ${missing.join(', ')}`);
  process.exit(2);
}
const passwordBytes = Buffer.byteLength(source.ADMIN_INITIAL_PASSWORD);
if (passwordBytes < 16 || passwordBytes > 72) {
  console.error('ADMIN_INITIAL_PASSWORD must be 16–72 bytes.');
  process.exit(2);
}

const stringData = Object.fromEntries([...required, ...optional]
  .filter(key => source[key])
  .map(key => [key, source[key]]));
const existing = spawnSync('kubectl', [
  '-n', 'cnp-portal', 'get', 'secret', 'cnp-portal-app-env', '-o', 'json',
], { encoding: 'utf8' });
if (existing.status !== 0 && !existing.stderr.includes('NotFound')) {
  console.error(existing.stderr || 'Could not read the existing portal Secret.');
  process.exit(existing.status || 1);
}
const prior = existing.status === 0
  ? JSON.parse(existing.stdout).data?.SESSION_SECRET
  : null;
stringData.SESSION_SECRET = prior
  ? Buffer.from(prior, 'base64').toString('utf8')
  : Buffer.byteLength(source.SESSION_SECRET || '') >= 32
    ? source.SESSION_SECRET
    : randomBytes(48).toString('base64url');
if (source.GITHUB_CLIENT_ID && source.GITHUB_CLIENT_SECRET) {
  stringData.GITHUB_REDIRECT_URI = 'https://portal.apps.mooroon5.fr/auth/github/callback';
}

// Argo CD's in-cluster DNS name is covered by its certificate. Keep the
// Terraform-supplied credentials, but override its legacy public-IP endpoint
// and insecure flag with a verified TLS connection.
const argoSecret = spawnSync('kubectl', [
  '-n', 'argocd', 'get', 'secret', 'argocd-secret', '-o', 'json',
], { encoding: 'utf8' });
if (argoSecret.status !== 0) {
  console.error(argoSecret.stderr || 'Could not read the Argo CD TLS certificate.');
  process.exit(argoSecret.status || 1);
}
const argoCert = JSON.parse(argoSecret.stdout).data?.['tls.crt'];
if (!argoCert) {
  console.error('Argo CD TLS certificate is missing.');
  process.exit(2);
}
stringData.ARGOCD_SERVER_URL = 'https://argocd-server.argocd.svc';
stringData.ARGOCD_INSECURE = 'false';
stringData.ARGOCD_CA_CERT_BASE64 = argoCert;

const secret = {
  apiVersion: 'v1', kind: 'Secret',
  metadata: { name: 'cnp-portal-app-env', namespace: 'cnp-portal' },
  type: 'Opaque', stringData,
};
const result = spawnSync('kubectl', ['apply', '-f', '-'], {
  input: JSON.stringify(secret), encoding: 'utf8',
});
if (result.status !== 0) {
  console.error(result.stderr || 'kubectl apply failed');
  process.exit(result.status || 1);
}
console.log('Applied cnp-portal/cnp-portal-app-env (values hidden).');
