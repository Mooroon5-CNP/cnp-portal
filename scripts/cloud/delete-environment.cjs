#!/usr/bin/env node
'use strict';

// Operator recovery entrypoint: uses the exact durable deletion path of the portal.
// Run from cnp-portal/ with its usual .env/.env.cloud and DB_PATH.
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { values } = parseArgs({ options: {
  app: { type: 'string' }, environment: { type: 'string' }, confirm: { type: 'string' },
  'destroy-data': { type: 'boolean', default: false }, status: { type: 'boolean', default: false },
} });

async function main() {
  if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(values.app || '') || !['dev', 'prod'].includes(values.environment)) {
    throw new Error('Utilisation : --app <nom> --environment dev|prod --confirm delete [--destroy-data], ou --status.');
  }
  require('../../src/config/env');
  const deployments = require('../../src/models/deployment');
  const deletion = require('../../src/services/environment-deletion');
  const row = deployments.listForUser(null).find(row => row.app_name === values.app && row.deployment_environment === values.environment);
  if (!row) throw new Error('Aucun déploiement enregistré correspondant ; aucun nettoyage effectué.');
  const dep = deployments.get(row.id);
  if (values.status) {
    const job = deletion.get(dep.id);
    console.log(JSON.stringify({ app: dep.appName, environment: dep.environment, status: dep.onboardingStatus,
      step: job?.step || null, state: job?.state || null, message: job?.message || null }, null, 2));
    return;
  }
  if (values.confirm !== 'delete') throw new Error('Confirmation requise : --confirm delete.');
  if (dep.targetCluster !== 'gcp' || require('../../src/services/environment-failover').enabled(dep)) {
    throw new Error('Cet outil de reprise couvre uniquement GCP hors failover ; utilisez le portail pour les autres parcours.');
  }
  const operator = require('../../src/models/user').findByUsername('admin');
  if (!operator?.active) throw new Error('Compte opérateur local admin indisponible.');
  deletion.start(dep, operator, { destroyData: values['destroy-data'] });
  let previous;
  const deadline = Date.now() + 3900000;
  while (Date.now() < deadline) {
    await deletion.advance(dep.id);
    const job = deletion.get(dep.id);
    const message = `${job.step} : ${job.message || job.state}`;
    if (message !== previous) { console.log(message); previous = message; }
    if (job.state === 'completed') return;
    if (job.state === 'failed') throw new Error(job.message);
    await delay(5000);
  }
  throw new Error('Délai de suivi dépassé ; la tâche est conservée et peut être reprise.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
