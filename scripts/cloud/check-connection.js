'use strict';

const axios = require('axios');
const https = require('https');
const { config } = require('../../src/config/env');
const argo = require('../../src/clients/argocd');
const { provisionArgoCDLocalUser } = require('../../src/clients/kubernetes');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

async function main() {
  const apps = await argo.listApplications();
  console.log(`Argo CD authenticated: ${apps.length} applications visible.`);
  const kube = axios.create({
    baseURL: config.kubernetes.apiUrl, timeout: 15000,
    headers: { Authorization: `Bearer ${config.kubernetes.token}` },
    httpsAgent: new https.Agent({ ca: Buffer.from(config.kubernetes.caCert, 'base64') }),
  });
  await kube.get('/api/v1/namespaces');
  // Use the same SDK and payload as regeneration, without persisting a test account.
  await provisionArgoCDLocalUser('cnp-portal-connectivity-check', bcrypt.hashSync(randomUUID(), 10), { dryRun: true });
  console.log('Kubernetes authenticated; Argo CD account-provisioning patches authorized (dry run).');
}

if (require.main === module) {
  main().catch(err => {
    console.error(err.isAxiosError ? `Connection check failed: HTTP ${err.response?.status || err.code}. Check portal credentials and Terraform RBAC.` : err.message);
    process.exitCode = 1;
  });
}
module.exports = { main };
