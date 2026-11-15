'use strict';

const records = require('../models/deployment_variables');
const variables = require('./openbao-variables');
const { GcpVariableDelivery } = require('./openbao-delivery-gcp');

async function references(deployment) {
  if (!records.get(deployment.id)) return [];
  const published = await variables.service().published(deployment);
  if (!published) return [];
  if (deployment.targetCluster !== 'gcp' || deployment.failoverRequested) {
    throw new Error('Livraison des variables OpenBao de ce mode indisponible. Publication arrêtée.');
  }
  // OpenBao is opt-in per deployment. The account/region must be supplied by the
  // actual portal runtime; never use the legacy defaults from config/env.js.
  if (!process.env.GCP_PROJECT || !process.env.GCP_REGION || !process.env.GCP_CLOUD_RUN_SA) {
    throw new Error('Configuration GCP des variables OpenBao manquante.');
  }
  const delivery = new GcpVariableDelivery({ project: process.env.GCP_PROJECT, region: process.env.GCP_REGION,
    runtimeServiceAccount: process.env.GCP_CLOUD_RUN_SA });
  return delivery.deliver(deployment, published.values.gcp);
}

module.exports = { references };
