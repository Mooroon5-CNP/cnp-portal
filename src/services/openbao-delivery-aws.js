'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { validate } = require('./openbao-variables');

const REGION = /^[a-z]{2}-[a-z]+-[0-9]$/;

function deliver(deployment, generation, values, { region = process.env.CNP_AWS_REGION,
  python = process.env.CNP_FAILOVER_PYTHON || 'python3', execute = execFileSync } = {}) {
  const entries = validate(values);
  if (deployment.targetCluster !== 'gcp' || deployment.environment !== 'prod' || !deployment.failoverRequested
    || !REGION.test(region) || !/^[0-9a-f-]{36}$/i.test(generation || '')) {
    throw new Error('Configuration AWS des variables invalide.');
  }
  if (!entries.length) return [];
  const script = path.resolve(__dirname, '../../scripts/failover/engine/openbao_variables_aws.py');
  try {
    const output = execute(python, [script], { input: JSON.stringify({ app: deployment.appName,
      generation, values: Object.fromEntries(entries), region }), encoding: 'utf8', timeout: 30000,
    maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    const references = JSON.parse(output);
    if (!Array.isArray(references) || references.length !== entries.length
      || references.some((item, index) => item.name !== entries[index][0]
        || !/^arn:aws:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:cnp\/failover\/[a-z0-9-]+\/env-[a-f0-9]{12}-[A-Za-z0-9]{6}:::[0-9a-f-]{36}$/.test(item.valueFrom))) {
      throw new Error('Références AWS invalides.');
    }
    return references;
  } catch (_) {
    throw new Error('Livraison AWS des variables indisponible ou refusée.');
  }
}

module.exports = { deliver };
