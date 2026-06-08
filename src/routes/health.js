'use strict';

const express = require('express');
const router = express.Router();
const { getMissingVars } = require('../config/env');

// GET /api/health — connectivity check for all external services
// HTTP 200 if all ok, HTTP 207 if any service is in error
router.get('/health', async (req, res) => {
  const missing = getMissingVars();
  const results = {};

  // Short-circuit: report unconfigured services without attempting connections
  const unconfigured = (vars) => vars.some(v => missing.includes(v));

  const checks = {
    github: {
      vars: ['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_INSTALLATION_ID'],
      run: () => require('../clients/github').checkConnectivity(),
    },
    argocd: {
      vars: ['ARGOCD_SERVER_URL', 'ARGOCD_TOKEN'],
      run: () => require('../clients/argocd').checkConnectivity(),
    },
    datadog: {
      vars: ['DD_API_KEY', 'DD_APP_KEY'],
      run: () => require('../clients/datadog').checkConnectivity(),
    },
    kubernetes: {
      vars: ['KUBE_API_URL', 'KUBE_TOKEN', 'KUBE_CA_CERT'],
      run: () => require('../clients/kubernetes').checkConnectivity(),
    },
    crossplane: {
      vars: ['KUBE_API_URL', 'KUBE_TOKEN', 'KUBE_CA_CERT'],
      run: () => require('../clients/kubernetes').getCompositeResources(),
    },
  };

  await Promise.all(
    Object.entries(checks).map(async ([service, { vars, run }]) => {
      if (unconfigured(vars)) {
        const missingForService = vars.filter(v => missing.includes(v));
        results[service] = { status: 'unconfigured', missing: missingForService };
        return;
      }
      try {
        await run();
        results[service] = { status: 'ok' };
      } catch (err) {
        results[service] = { status: 'error', message: err.message };
      }
    }),
  );

  const hasError = Object.values(results).some(r => r.status !== 'ok');
  res.status(hasError ? 207 : 200).json(results);
});

module.exports = router;
