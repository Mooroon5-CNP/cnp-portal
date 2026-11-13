'use strict';

// Current ClusterIP deployments: a foreground tunnel, supervised by the operator.
// Future Terraform deployments expose a LoadBalancer and do not need this command.
require('dotenv').config();
require('../../src/config/cloud-env').loadCloudEnv();
const { execFileSync, spawn } = require('child_process');

function main() {
  const url = new URL(process.env.ARGOCD_SERVER_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('This environment uses a remote Argo CD endpoint; no local tunnel is needed.');
  const config = JSON.parse(execFileSync('kubectl', ['config', 'view', '--minify', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (config.clusters[0].cluster.server !== process.env.KUBE_API_URL) throw new Error('kubectl context does not match the portal KUBE_API_URL. Select the intended context first.');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const remotePort = url.protocol === 'https:' ? '443' : '80';
  console.log(`Forwarding Argo CD to ${url.origin}. Keep this process running and start the portal in another terminal.`);
  const child = spawn('kubectl', ['-n', 'argocd', 'port-forward', '--address=127.0.0.1', 'service/argocd-server', `${port}:${remotePort}`], { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal));
  child.once('error', () => { console.error('Unable to start kubectl'); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code || 0; });
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}

module.exports = { main };
