'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const { writeContract } = require('./import-terraform');

function main(argv, { run = execFileSync } = {}) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--context', '--project', '--output'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error('Expected --context NAME --project ID [--output .env.cloud]');
    }
    opts[argv[i]] = argv[i + 1];
  }
  if (!opts['--context'] || !opts['--project']) throw new Error('--context and --project are required');
  const context = opts['--context'];
  const project = opts['--project'];
  if (!context.startsWith(`gke_${project}_`)) throw new Error('The selected GKE context does not match --project');
  const execute = args => {
    try { return JSON.parse(run('kubectl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 })); }
    catch (_) { throw new Error('Cannot read the selected cluster configuration. Check kubectl access and the cnp-portal/cnp-portal-cloud-env Secret. No local settings were changed.'); }
  };
  const config = execute(['--context', context, 'config', 'view', '--minify', '-o', 'json']);
  const server = config.clusters?.[0]?.cluster?.server;
  if (!server || new URL(server).protocol !== 'https:') throw new Error('The selected context must expose an HTTPS Kubernetes endpoint');
  // Read only this existing platform configuration Secret, never a user/admin token.
  const secret = execute(['--context', context, '--request-timeout=10s', 'get', 'secret',
    'cnp-portal-cloud-env', '--namespace=cnp-portal', '-o', 'json']);
  const values = Object.fromEntries(Object.entries(secret.data || {}).map(([key, value]) => [key, Buffer.from(value, 'base64').toString('utf8')]));
  if (values.GCP_PROJECT !== project || values.KUBE_API_URL !== server) {
    throw new Error('Cloud configuration project/endpoint does not match the selected context. No local settings were changed.');
  }
  const output = path.resolve(opts['--output'] || '.env.cloud');
  writeContract(values, output);
  return { output, project, server };
}
if (require.main === module) {
  try {
    const { output, project, server } = main(process.argv.slice(2));
    console.log(`Cloud settings imported into ${output} (0600): ${project}, ${server}. Restart the portal. No cloud resources changed.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
