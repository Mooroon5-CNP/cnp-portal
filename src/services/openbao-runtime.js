'use strict';

const records = require('../models/deployment_variables');
const variables = require('./openbao-variables');
const { GcpVariableDelivery } = require('./openbao-delivery-gcp');
const { AzureVariableDelivery } = require('./openbao-delivery-azure');
const awsDelivery = require('./openbao-delivery-aws');
const { roleArnFor } = require('./openbao-aws-identity');
const provisioner = require('./openbao-runtime-provisioner-client');
const { OpenBaoClient } = require('./openbao-client');
const { domainsForDeployment } = require('./openbao-routing');
const { config } = require('../config/env');
const yaml = require('js-yaml');
const { createHash } = require('crypto');

const IDENTITY = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/[A-Za-z0-9_.-]+$/i;

function identityMap(envName, error) {
  try {
    const parsed = JSON.parse(process.env[envName] || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) { /* invalid mapping */ }
  throw new Error(error);
}

const suffix = deployment => createHash('sha256').update(`${deployment.appName}/${deployment.environment}`).digest('hex').slice(0, 20);
const derived = () => process.env.CNP_OPENBAO_DERIVED_IDENTITIES === 'true' || !!process.env.CNP_OPENBAO_RUNTIME_PROVISIONER_ADDR;

// Avec le provisionneur, le rôle AWS est créé, relu et simulé avant d'être utilisé (openbao-aws-identity.js) ; son ARN,
// sous /cnp-runtime/, se déduit du nom de l'app. Sans provisionneur, seule la table explicite est acceptée.
function awsRuntimeRole(deployment) {
  const key = `${deployment.appName}/prod`;
  const roles = derived('aws') ? {} : identityMap('CNP_AWS_RUNTIME_EXECUTION_ROLES', 'Rôles AWS des applications invalides.');
  const role = derived('aws') ? roleArnFor(deployment.appName, process.env.CNP_AWS_ACCOUNT_ID) : roles[key];
  if (!/^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@/-]+$/.test(role || '')
    || Object.entries(roles).some(([other, value]) => other !== key && value === role)) {
    throw new Error('Rôle AWS d’exécution dédié à cette application manquant.');
  }
  return role;
}

function azureRuntimeIdentity(deployment) {
  const identities = derived('azure') ? {} : identityMap('CNP_AZURE_RUNTIME_IDENTITIES', 'Identités Azure des applications invalides.');
  const key = `${deployment.appName}/${deployment.environment}`;
  const subscription = process.env.AZURE_SUBSCRIPTION_ID;
  const group = process.env.CNP_AZURE_RUNTIME_RESOURCE_GROUP;
  const identity = derived('azure') ? (/^[0-9a-f-]{36}$/i.test(subscription || '')
    && /^[A-Za-z0-9_.()-]+$/.test(group || '')
    ? `/subscriptions/${subscription}/resourceGroups/${group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cnp-${suffix(deployment)}-vars` : null) : identities?.[key];
  if (!IDENTITY.test(identity || '') || identity.toLowerCase() === config.azure.pullIdentityId?.toLowerCase()
    || Object.entries(identities).some(([other, value]) => other !== key && typeof value === 'string'
      && value.toLowerCase() === identity.toLowerCase())) {
    throw new Error('Identité Azure dédiée à cette application manquante.');
  }
  return identity;
}

function gcpRuntimeIdentity(deployment) {
  const identities = derived('gcp') ? {} : identityMap('CNP_GCP_RUNTIME_IDENTITIES', 'Identités GCP des applications invalides.');
  const key = `${deployment.appName}/${deployment.environment}`;
  const identity = derived('gcp') ? (process.env.GCP_PROJECT
    ? `cnp-${suffix(deployment)}@${process.env.GCP_PROJECT}.iam.gserviceaccount.com` : null) : identities[key];
  const expected = new RegExp(`^[a-z][a-z0-9-]*@${String(process.env.GCP_PROJECT || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.iam\\.gserviceaccount\\.com$`);
  if (!expected.test(identity || '') || identity === config.gcp.cloudRunSa
    || Object.entries(identities).some(([other, value]) => other !== key && value === identity)) {
    throw new Error('Compte GCP runtime dédié à cette application manquant.');
  }
  return identity;
}

function assertReady(deployment) {
  const domains = domainsForDeployment(deployment);
  for (const domain of domains) OpenBaoClient.fromEnvironment(domain);
  // Cloud privé : External Secrets lit OpenBao dans le cluster, aucune identité cloud à préparer.
  if (deployment.targetCluster === 'private-aws') return;
  if (deployment.targetCluster === 'azure') {
    azureRuntimeIdentity(deployment);
    AzureVariableDelivery.fromEnvironment(deployment);
    return;
  }
  if (!process.env.GCP_PROJECT || !process.env.GCP_REGION) throw new Error('Configuration GCP des variables OpenBao manquante.');
  gcpRuntimeIdentity(deployment);
  if (deployment.failoverRequested) {
    awsRuntimeRole(deployment);
    if (!/^[a-z]{2}-[a-z]+-[0-9]$/.test(process.env.CNP_AWS_REGION || '')) {
      throw new Error('Rôle AWS d’exécution dédié à cette application manquant.');
    }
  }
}

async function azureReferences(deployment) {
  if (!records.get(deployment.id)) return null;
  const identity = azureRuntimeIdentity(deployment);
  const published = await variables.service().published(deployment);
  if (!published) return null;
  return { identity, references: await AzureVariableDelivery.fromEnvironment(deployment).deliver(deployment, published.values.azure) };
}

async function failoverReferences(deployment, profile, imageRecord) {
  if (!records.get(deployment.id)) return null;
  if (!deployment.failoverRequested || deployment.environment !== 'prod' || deployment.targetCluster !== 'gcp') {
    throw new Error('Variables du secours réservées à GCP PostgreSQL prod.');
  }
  // Reprise idempotente avant chaque publication : identités GCP et rôle AWS revérifiés chez les fournisseurs.
  await provisioner.ensure(deployment);
  const serviceAccount = gcpRuntimeIdentity(deployment);
  if (profile?.gcp?.gcp_runtime?.service_account !== serviceAccount) {
    throw new Error('Le profil failover doit utiliser le compte GCP dédié avant la publication des variables.');
  }
  const role = awsRuntimeRole(deployment);
  const account = imageRecord?.aws?.match(/^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\//);
  if (!account || !new RegExp(`^arn:aws:iam::${account[1]}:role/[A-Za-z0-9_+=,.@/-]+$`).test(role || '')
    || !process.env.CNP_AWS_REGION || process.env.CNP_AWS_REGION !== account[2]) {
    throw new Error('Rôle AWS d’exécution dédié à cette application manquant.');
  }
  if (!process.env.GCP_PROJECT || !process.env.GCP_REGION) throw new Error('Configuration GCP des variables OpenBao manquante.');
  const published = await variables.service().published(deployment);
  if (!published) return null;
  const gcp = await new GcpVariableDelivery({ project: process.env.GCP_PROJECT, region: process.env.GCP_REGION,
    runtimeServiceAccount: serviceAccount }).deliver(deployment, published.values.gcp);
  const aws = awsDelivery.deliver(deployment, published.generation, published.values.aws);
  return { gcp, aws, aws_execution_role: role };
}

// Cloud privé : rien n'est copié. Le manifeste référence la version publiée (ExternalSecret, private-templates.js).
async function privateReferences(deployment) {
  if (!records.get(deployment.id)) return null;
  if (deployment.targetCluster !== 'private-aws') throw new Error('Variables du cloud privé réservées au cloud privé.');
  const published = await variables.service().published(deployment);
  if (!published) return null;
  return { version: published.versions.private, names: Object.keys(published.values.private) };
}

function applyAzureReferences(files, deployment, prepared) {
  if (!prepared || !prepared.references.length) return files;
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

module.exports = { references, azureReferences, applyAzureReferences, privateReferences, azureRuntimeIdentity, gcpRuntimeIdentity,
  awsRuntimeRole, failoverReferences, assertReady };
