'use strict';
// One-time operator deployment. Application values stay in this process and GCS,
// never in CI, a command argument, Git, or a rendered Cloud Run manifest.
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFileSync } = require('child_process'); const { randomBytes, X509Certificate } = require('crypto');
const { parseFile } = require('../../public/js/application-variables');
const { previewId } = require('./prepare-preview.cjs'); const { render } = require('./render-preview.cjs');
const { request, validateValues } = require('../runtime/variables.cjs');
const PROJECT = 'cnp-terraform-512313'; const REGION = 'europe-west9';
const REGISTRY = 'europe-west9-docker.pkg.dev/cnp-terraform-512313/cnp-registry/cnp-portal';
let step = 'local checks';
function stage(name) { step = name; console.error(`Preview: ${name}`); }
function command(name, args) { return execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 45000 }).trim(); }
async function main() {
  process.env.CNP_VARIABLES_PROVIDER = 'gcs';
  const file = path.resolve(process.argv[2] || '.env');
  const raw = fs.readFileSync(file); if (raw.length > 262144) throw new Error('ENV_FILE_TOO_LARGE');
  const values = Object.fromEntries(parseFile(raw.toString('utf8')).map(row => [row.name, row.value]));
  const { config } = require('../../src/config/env');
  if (config.gcp.project !== PROJECT || config.gcp.region !== REGION) throw new Error('GCP_TARGET_MISMATCH');
  // Use the operator's already loaded cloud overrides, as the local portal does.
  for (const key of require('../../src/config/cloud-env').CLOUD_KEYS) if (process.env[key] !== undefined) values[key] = process.env[key];
  values.GCP_PROJECT = PROJECT; values.GCP_REGION = REGION; values.NODE_ENV = 'production';
  const context = command('kubectl', ['config', 'current-context']);
  if (context !== 'gke_cnp-terraform-512313_europe-west9-b_cnp-cluster-terraform') throw new Error('KUBERNETES_CONTEXT_MISMATCH');
  stage('verify the current branch commit has a successful scanned image');
  if (command('git', ['branch', '--show-current']) !== 'fix/cloudrun-environment') throw new Error('SOURCE_BRANCH_MISMATCH');
  const sourceRevision = command('git', ['rev-parse', 'HEAD']);
  const github = await require('../../src/clients/github').getInstallationOctokit();
  const runs = await github.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    owner: 'Mooroon5-CNP', repo: 'cnp-portal', workflow_id: 'cnp-preview.yml', head_sha: sourceRevision, per_page: 10,
  });
  if (!runs.data.workflow_runs?.some(run => run.head_sha === sourceRevision && run.status === 'completed' && run.conclusion === 'success')) throw new Error('SOURCE_CI_NOT_SUCCESSFUL');
  const digest = command('gcloud', ['artifacts', 'docker', 'images', 'describe', `${REGISTRY}:${sourceRevision}`, `--project=${PROJECT}`, '--format=value(image_summary.digest)']);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('SCANNED_IMAGE_DIGEST_MISSING');
  const image = `${REGISTRY}@${digest}`;
  if (values.ARGOCD_INSECURE === 'true') {
    stage('pin the public ArgoCD certificate from the authenticated cluster');
    let encoded;
    for (const name of ['argocd-server-tls', 'argocd-secret']) {
      try { encoded = command('kubectl', ['-n', 'argocd', 'get', 'secret', name, '-o', 'jsonpath={.data.tls\\.crt}']); if (encoded) break; } catch (_) { /* Try the canonical fallback Secret. */ }
    }
    if (!encoded) throw new Error('ARGOCD_TRUSTED_CERTIFICATE_MISSING');
    const certificate = new X509Certificate(Buffer.from(encoded, 'base64'));
    const endpoint = new URL(values.ARGOCD_SERVER_URL);
    if (endpoint.protocol !== 'https:') throw new Error('ARGOCD_HTTPS_REQUIRED');
    const names = [endpoint.hostname, 'argocd-server.argocd.svc.cluster.local', 'argocd-server.argocd.svc', 'argocd-server.argocd', 'argocd-server', 'localhost'];
    const serverName = names.find(name => require('net').isIP(name) ? certificate.checkIP(name) : certificate.checkHost(name));
    if (!serverName) throw new Error('ARGOCD_CERTIFICATE_NAME_MISMATCH');
    values.ARGOCD_CA_CERT = encoded; values.ARGOCD_TLS_SERVER_NAME = serverName; values.ARGOCD_INSECURE = 'false';
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-portal-preview-')); fs.chmodSync(dir, 0o700);
  if (!values.SESSION_SECRET || Buffer.byteLength(values.SESSION_SECRET) < 32) values.SESSION_SECRET = randomBytes(48).toString('hex');
  if (!values.ADMIN_INITIAL_PASSWORD || Buffer.byteLength(values.ADMIN_INITIAL_PASSWORD) < 16 || Buffer.byteLength(values.ADMIN_INITIAL_PASSWORD) > 72) {
    values.ADMIN_INITIAL_PASSWORD = randomBytes(24).toString('base64url');
    fs.writeFileSync(path.join(dir, 'admin-password.txt'), values.ADMIN_INITIAL_PASSWORD + '\n', { mode: 0o600, flag: 'wx' });
  }
  validateValues(values);
  const dep = { id: previewId(PROJECT), appName: 'cnp-portal', environment: 'dev', targetCluster: 'gcp' };
  stage('check isolated preview ownership');
  try {
    const existing = JSON.parse(command('kubectl', ['-n', 'crossplane-system', 'get', 'v2services.cloudrun.gcp.upbound.io', 'cnp-portal-preview', '-o', 'json']));
    if (existing.metadata?.labels?.['cnp.io/preview'] !== 'cloudrun-env-20261104') throw new Error('EXISTING_PREVIEW_NOT_OWNED');
  } catch (error) { if (!/NotFound|not found/.test(String(error.stderr || ''))) throw error; }
  stage('Google authentication');
  const token = command('gcloud', ['auth', 'print-access-token', '--quiet']);
  const credentials = { token: async () => token, headers: async () => ({ Authorization: `Bearer ${token}` }) };
  stage('private bucket and isolated runtime identity');
  const provider = require('../../src/clients/variable-bundles');
  await provider.prepare(dep, credentials);
  const bundle = await provider.write(dep, values, credentials);
  const profile = { schemaVersion: 1, service: 'cnp-portal-preview', project: PROJECT, region: REGION, runtimeAccount: provider.runtimeAccount(dep), bundle };
  fs.writeFileSync(path.join(dir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  stage('grant scoped backend control role');
  const roleFile = path.join(dir, 'control-role.json');
  fs.writeFileSync(roleFile, JSON.stringify({ title: 'CNP preview bundle control', description: 'Dedicated portal control only', stage: 'GA', includedPermissions: provider.GCS_PERMISSIONS }), { mode: 0o600 });
  const roleName = 'cnpPreviewBundleControl';
  let role;
  try { role = JSON.parse(command('gcloud', ['iam', 'roles', 'describe', roleName, `--project=${PROJECT}`, '--format=json'])); }
  catch (error) {
    if (!/NOT_FOUND|does not exist/.test(String(error.stderr || ''))) throw error;
    command('gcloud', ['iam', 'roles', 'create', roleName, `--project=${PROJECT}`, `--file=${roleFile}`, '--quiet']);
  }
  if (role && (role.deleted || JSON.stringify([...(role.includedPermissions || [])].sort()) !== JSON.stringify([...provider.GCS_PERMISSIONS].sort()))) throw new Error('EXISTING_ROLE_MISMATCH');
  command('gcloud', ['projects', 'add-iam-policy-binding', PROJECT, `--member=serviceAccount:${profile.runtimeAccount}`, `--role=projects/${PROJECT}/roles/${roleName}`, '--quiet', '--format=none']);
  const manifest = render(profile, image);
  manifest.metadata.labels['cnp.io/preview'] = 'cloudrun-env-20261104';
  const manifestFile = path.join(dir, 'service.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  stage('apply isolated preview through Crossplane');
  command('kubectl', ['-n', 'crossplane-system', 'apply', '--field-manager=cnp-preview-operator', '-f', manifestFile]);
  stage('wait for the exact configuration to be observed and ready');
  const deadline = Date.now() + 240000; let service;
  while (Date.now() < deadline) {
    const resource = JSON.parse(command('kubectl', ['-n', 'crossplane-system', 'get', 'v2services.cloudrun.gcp.upbound.io', 'cnp-portal-preview', '-o', 'json']));
    const observed = resource.status?.atProvider;
    const observedRef = observed?.template?.containers?.[0]?.env?.find(item => item.name === 'CNP_VARIABLES_REF')?.value;
    if (observedRef === JSON.stringify(bundle.reference) && observed.latestCreatedRevision && observed.latestCreatedRevision === observed.latestReadyRevision && observed.terminalCondition?.some(item => item.state === 'CONDITION_SUCCEEDED' && item.type === 'Ready')) { service = observed; break; }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (!service) throw new Error('PREVIEW_ROLLOUT_TIMEOUT');
  stage('authenticated health check');
  const url = new URL(service.uri);
  if (url.protocol !== 'https:' || !url.hostname.startsWith('cnp-portal-preview-') || !url.hostname.endsWith('.a.run.app')) throw new Error('PREVIEW_URL_INVALID');
  const identityToken = command('gcloud', ['auth', 'print-identity-token', '--quiet']);
  await request(`${url.origin}/healthz`, { headers: { Authorization: `Bearer ${identityToken}` }, timeout: 10000 });
  console.log(JSON.stringify({ deployed: true, service: profile.service, url: url.origin, revision: service.latestReadyRevision,
    metadataDirectory: dir, generatedAdminPasswordFile: fs.existsSync(path.join(dir, 'admin-password.txt')) ? path.join(dir, 'admin-password.txt') : null,
    next: 'gcloud run services proxy cnp-portal-preview --project=cnp-terraform-512313 --region=europe-west9 --port=8090' }, null, 2));
}
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ deployed: false, step, code: typeof error.code === 'string' ? error.code : /^[A-Z_]+$/.test(error.message || '') ? error.message : 'PREVIEW_DEPLOY_FAILED', httpStatus: error.status || null, message: 'No existing portal service was changed. Check operator permissions and the named stage; configuration values were not logged.' })); process.exitCode = 1; });
