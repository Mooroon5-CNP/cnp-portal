'use strict';

const records = require('../models/deployment_variables');
const variables = require('./openbao-variables');
const { GcpVariableDelivery } = require('./openbao-delivery-gcp');
const { AzureVariableDelivery } = require('./openbao-delivery-azure');
const { config } = require('../config/env');
const yaml = require('js-yaml');

const IDENTITY = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_.-]+$/i;

function identityMap(envName, error) {
  try {
    const parsed = JSON.parse(process.env[envName] || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { /* invalid mapping */ }
  throw new Error(error);
}

function azureRuntimeIdentity(deployment) {
  const identities = identityMap('CNP_AZURE_RUNTIME_IDENTITIES', 'Identités Azure des applications invalides.');
  const key = `${deployment.appName}/${deployment.environment}`;
  const identity = identities?.[key];
  if (!IDENTITY.test(identity || '') || identity.toLowerCase() === config.azure.pullIdentityId?.toLowerCase()
    || Object.entries(identities).some(([other, value]) => other !== key && typeof value === 'string'
      && value.toLowerCase() === identity.toLowerCase())) {
    throw new Error('Identité Azure dédiée à cette application manquante.');
  }
  return identity;
}

function gcpRuntimeIdentity(deployment) {
  const identities = identityMap('CNP_GCP_RUNTIME_IDENTITIES', 'Identités GCP des applications invalides.');
  const key = `${deployment.appName}/${deployment.environment}`;
  const identity = identities[key];
  const expected = new RegExp(`^[a-z][a-z0-9-]*@${String(process.env.GCP_PROJECT || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.iam\\.gserviceaccount\\.com$`);
  if (!expected.test(identity || '') || identity === config.gcp.cloudRunSa
    || Object.entries(identities).some(([other, value]) => other !== key && value === identity)) {
    throw new Error('Compte GCP runtime dédié à cette application manquant.');
  }
  return identity;
}

async function azureReferences(deployment) {
  if (!records.get(deployment.id)) return null;
  const identity = azureRuntimeIdentity(deployment);
  const published = await variables.service().published(deployment);
  if (!published) return null;
  return { identity, references: await AzureVariableDelivery.fromEnvironment().deliver(deployment, published.values.azure) };
}

function applyAzureReferences(files, deployment, prepared) {
  if (!prepared) return files;
  const dir = `apps/${deployment.appName}/crossplane/${deployment.environment}`;
  const claimPath = `${dir}/containerapp-claim.yaml`;
  const namesPath = `${dir}/containerapp-secretname.yaml`;
  const claim = yaml.load(files[claimPath]);
  const names = yaml.load(files[namesPath]);
  if (!claim?.spec?.forProvider?.template?.container?.[0] || !Array.isArray(claim.spec.forProvider.secret)
    || !names?.stringData || !Array.isArray(claim.spec.forProvider.identity?.identityIds)) {
    throw new Error('Manifests Azure inattendus pour les variables.');
  }
  const container = claim.spec.forProvider.template.container[0];
  const occupied = new Set(container.env.map(item => item.name));
  for (const reference of prepared.references) {
    if (occupied.has(reference.name)) throw new Error('Variable OpenBao en conflit avec le runtime Azure.');
    occupied.add(reference.name);
    const key = `var-${reference.secretName}`;
    names.stringData[key] = reference.secretName;
    claim.spec.forProvider.secret.push({ nameSecretRef: { name: names.metadata.name, namespace: names.metadata.namespace, key },
      keyVaultSecretId: reference.keyVaultSecretId, identity: prepared.identity });
    container.env.push({ name: reference.name, secretName: reference.secretName });
  }
  claim.spec.forProvider.identity.identityIds.push(prepared.identity);
  files[claimPath] = yaml.dump(claim);
  files[namesPath] = yaml.dump(names);
  return files;
}

async function references(deployment) {
  if (!records.get(deployment.id)) return [];
  const published = await variables.service().published(deployment);
  if (!published) return [];
  if (deployment.targetCluster !== 'gcp' || deployment.failoverRequested) {
    throw new Error('Livraison des variables OpenBao de ce mode indisponible. Publication arrêtée.');
  }
  // OpenBao is opt-in per deployment. The account/region must be supplied by the
  // actual portal runtime; never use the legacy defaults from config/env.js.
  if (!process.env.GCP_PROJECT || !process.env.GCP_REGION) {
    throw new Error('Configuration GCP des variables OpenBao manquante.');
  }
  const runtimeServiceAccount = gcpRuntimeIdentity(deployment);
  const delivery = new GcpVariableDelivery({ project: process.env.GCP_PROJECT, region: process.env.GCP_REGION,
    runtimeServiceAccount });
  return delivery.deliver(deployment, published.values.gcp);
}

module.exports = { references, azureReferences, applyAzureReferences, azureRuntimeIdentity, gcpRuntimeIdentity };
