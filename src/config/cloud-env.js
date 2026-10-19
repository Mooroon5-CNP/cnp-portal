'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const CLOUD_KEYS = [
  'GCP_PROJECT', 'GCP_REGION', 'GCP_IMAGE_REGISTRY', 'GCP_CLOUD_RUN_SA',
  'GITHUB_REGISTRY_URL', 'GITHUB_GCP_SA_EMAIL', 'GITHUB_WIF_PROVIDER',
  'KUBE_API_URL', 'KUBE_CA_CERT', 'KUBE_TOKEN',
  'ARGOCD_SERVER_URL', 'ARGOCD_UI_URL', 'ARGOCD_USERNAME', 'ARGOCD_PASSWORD', 'ARGOCD_TOKEN', 'ARGOCD_INSECURE',
  'CLUSTER_BASE_DOMAIN',
];

function loadCloudEnv(file = process.env.CLOUD_ENV_FILE || path.resolve('.env.cloud'), target = process.env) {
  if (!fs.existsSync(file)) {
    if (process.env.CLOUD_ENV_FILE) throw new Error('Configured CLOUD_ENV_FILE does not exist');
    return;
  }
  const values = dotenv.parse(fs.readFileSync(file));
  for (const key of CLOUD_KEYS) {
    // An empty ARGOCD_TOKEN intentionally switches a legacy setup to login auth.
    if (Object.prototype.hasOwnProperty.call(values, key)) target[key] = values[key];
  }
}

module.exports = { CLOUD_KEYS, loadCloudEnv };
