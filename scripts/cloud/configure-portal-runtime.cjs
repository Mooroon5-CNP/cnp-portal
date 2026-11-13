'use strict';

// Run from the portal checkout with gcloud and git authenticated. Secret values
// travel through stdin; only Secret Manager references are committed to GitOps.
require('dotenv').config();
const { execFileSync } = require('child_process');
const { randomBytes } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const project = process.argv[2];
const repo = process.argv[3];
if (!project || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repo || '')) {
  throw new Error('Usage: node scripts/cloud/configure-portal-runtime.cjs PROJECT https://github.com/ORG/config-repo.git');
}
function run(command, args, input) {
  return execFileSync(command, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function cloud(args, input) { return run('gcloud', [...args, `--project=${project}`, '--quiet'], input); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-runtime-'));
try {
  run('git', ['clone', '--depth=1', '--branch=main', repo, dir]);
  const relative = 'apps/cnp-portal/crossplane/dev';
  const claimPath = path.join(dir, relative, 'cloudrun-claim.yaml');
  const claim = yaml.load(fs.readFileSync(claimPath, 'utf8'));
  const template = claim.spec.forProvider.template;
  if (claim.metadata.name !== 'cnp-portal-dev' || claim.spec.forProvider.project !== project || !template.serviceAccount) {
    throw new Error('GitOps service identity does not match the requested dev environment.');
  }
  const refs = [];
  for (const [name, suffix] of [['SESSION_SECRET', 'session-secret'], ['ADMIN_INITIAL_PASSWORD', 'admin-initial-password']]) {
    const id = `cnp-portal-dev-${suffix}`;
    const known = JSON.parse(cloud(['secrets', 'list', `--filter=name:/${id}`, '--format=json']));
    if (!known.some(secret => secret.name.endsWith(`/${id}`))) {
      const value = name === 'SESSION_SECRET' ? randomBytes(48).toString('hex') : process.env.ADMIN_INITIAL_PASSWORD;
      if (!value || Buffer.byteLength(value) < 16 || (name === 'ADMIN_INITIAL_PASSWORD' && Buffer.byteLength(value) > 72)) {
        throw new Error('Set ADMIN_INITIAL_PASSWORD in your local .env (16–72 bytes) before running this script.');
      }
      cloud(['secrets', 'create', id, '--replication-policy=automatic', '--data-file=-'], value);
    }
    cloud(['secrets', 'add-iam-policy-binding', id, `--member=serviceAccount:${template.serviceAccount}`, '--role=roles/secretmanager.secretAccessor']);
    const versions = JSON.parse(cloud(['secrets', 'versions', 'list', id, '--filter=state:ENABLED', '--format=json']));
    const version = versions.map(item => Number(item.name.split('/').pop())).sort((a, b) => b - a)[0];
    if (!version) throw new Error(`No enabled version in ${id}. Existing secrets are never overwritten.`);
    refs.push({ name, valueSource: { secretKeyRef: { secret: id, version: String(version) } } });
  }
  fs.writeFileSync(path.join(dir, relative, 'runtime-secrets.yaml'), yaml.dump(refs));
  const container = template.containers[0];
  container.env = (container.env || []).filter(item => !refs.some(ref => ref.name === item.name)).concat(refs);
  fs.writeFileSync(claimPath, yaml.dump(claim));
  run('git', ['-C', dir, 'add', `${relative}/runtime-secrets.yaml`, `${relative}/cloudrun-claim.yaml`]);
  const changed = run('git', ['-C', dir, 'diff', '--cached', '--name-only']);
  if (changed) {
    run('git', ['-C', dir, 'commit', '-m', 'fix(cnp-portal): bind dev runtime secrets from Secret Manager']);
    run('git', ['-C', dir, 'push', 'origin', 'HEAD:main']);
  }
  console.log('Dev runtime secret references configured in GitOps. ArgoCD will apply the new revision. Secret values were not printed or committed.');
} catch (error) {
  // Child-process errors can contain command output: expose no credentials.
  console.error(error.status !== undefined ? 'Command failed. Check gcloud/git authentication, API permissions and GitOps branch protection.' : error.message);
  process.exitCode = 1;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
