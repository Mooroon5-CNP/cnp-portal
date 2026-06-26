'use strict';

require('dotenv').config();

const REQUIRED_VARS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_CONFIG_REPO_NAME',
  'ARGOCD_SERVER_URL',
  'ARGOCD_TOKEN',
  'DD_API_KEY',
  'DD_APP_KEY',
  'KUBE_API_URL',
  'KUBE_TOKEN',
  'KUBE_CA_CERT',
];

function getMissingVars() {
  return REQUIRED_VARS.filter(v => !process.env[v] || process.env[v].trim() === '');
}

// When run directly: validate and exit with the list of missing vars
if (require.main === module) {
  const missing = getMissingVars();
  if (missing.length > 0) {
    missing.forEach(v => console.error(`MISSING ENV VAR: ${v}`));
    process.exit(1);
  }
  console.log('All required env vars are present.');
  process.exit(0);
}

function normalizePrivateKey(raw) {
  if (!raw) return null;
  // dotenv stores \n as literal two-char escape when the value is on one quoted line
  let key = raw.replace(/\\n/g, '\n').trim();
  // Add PEM armor if the downloaded key was pasted without headers
  if (!key.startsWith('-----')) {
    key = `-----BEGIN RSA PRIVATE KEY-----\n${key}\n-----END RSA PRIVATE KEY-----`;
  }
  return key;
}

const config = {
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: normalizePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY),
    installationId: process.env.GITHUB_APP_INSTALLATION_ID,
    configRepoName: process.env.GITHUB_CONFIG_REPO_NAME,
    configRepoToken: process.env.GITHUB_CONFIG_REPO_TOKEN || null,
    wifProvider: process.env.GITHUB_WIF_PROVIDER
      || 'projects/688655933459/locations/global/workloadIdentityPools/github-pool/providers/github-provider',
  },
  argocd: {
    serverUrl: process.env.ARGOCD_SERVER_URL,
    token: process.env.ARGOCD_TOKEN,
    insecure: process.env.ARGOCD_INSECURE === 'true',
    // Browser-accessible URL (may differ from serverUrl which can be in-cluster).
    // Falls back to serverUrl if not set.
    uiUrl: process.env.ARGOCD_UI_URL || process.env.ARGOCD_SERVER_URL || null,
  },
  datadog: {
    apiKey: process.env.DD_API_KEY,
    appKey: process.env.DD_APP_KEY,
    site: process.env.DD_SITE || 'datadoghq.com',
  },
  kubernetes: {
    apiUrl: process.env.KUBE_API_URL,
    token: process.env.KUBE_TOKEN,
    caCert: process.env.KUBE_CA_CERT,
    namespacePrefix: process.env.KUBE_NAMESPACE_PREFIX || '',
  },
  crossplane: {
    namespace: process.env.CROSSPLANE_NAMESPACE || 'crossplane-system',
  },
  cluster: {
    baseDomain: process.env.CLUSTER_BASE_DOMAIN || 'cnp.example.com',
  },
  gcp: {
    project:       process.env.GCP_PROJECT        || 'cnp-terraform-500015',
    region:        process.env.GCP_REGION         || 'europe-west9',
    // Full Artifact Registry prefix: europe-west9-docker.pkg.dev/<project>/cnp-registry
    imageRegistry: process.env.GCP_IMAGE_REGISTRY
      || `${process.env.GCP_REGION || 'europe-west9'}-docker.pkg.dev/${process.env.GCP_PROJECT || 'cnp-terraform-500015'}/cnp-registry`,
    cloudRunSa:    process.env.GCP_CLOUD_RUN_SA
      || `cloud-run-sa@${process.env.GCP_PROJECT || 'cnp-terraform-500015'}.iam.gserviceaccount.com`,
  },
};

module.exports = { config, getMissingVars };
