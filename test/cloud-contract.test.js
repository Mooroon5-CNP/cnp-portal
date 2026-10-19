'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CLOUD_KEYS, loadCloudEnv } = require('../src/config/cloud-env');
const { writeContract } = require('../scripts/cloud/import-terraform');
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-contract-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('Terraform import overrides stale cloud settings but cannot replace unrelated application secrets', () => {
  const file = path.join(dir, '.env.cloud');
  const values = Object.fromEntries(CLOUD_KEYS.map(key => [key, 'example']));
  Object.assign(values, { ARGOCD_TOKEN: '', KUBE_TOKEN: 'kubernetes-token', ARGOCD_PASSWORD: 'terraform-password', SESSION_SECRET: 'must-not-import' });
  writeContract(values, file);
  const env = { ARGOCD_TOKEN: 'old-token', GCP_PROJECT: 'old-project', SESSION_SECRET: 'keep-me' };
  loadCloudEnv(file, env);
  expect(env.ARGOCD_TOKEN).toBe('');
  expect(env.ARGOCD_PASSWORD).toBe('terraform-password');
  expect(env.GCP_PROJECT).toBe('example');
  expect(env.SESSION_SECRET).toBe('keep-me');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('an incomplete Terraform output does not replace the working imported environment', () => {
  const file = path.join(dir, '.env.cloud');
  fs.writeFileSync(file, 'existing');
  expect(() => writeContract({ GCP_PROJECT: 'new-project' }, file)).toThrow('missing');
  expect(fs.readFileSync(file, 'utf8')).toBe('existing');
});
