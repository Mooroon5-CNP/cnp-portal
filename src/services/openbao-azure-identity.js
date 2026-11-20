'use strict';

const axios = require('axios');
const { createHash } = require('crypto');
const { federatedAccessToken } = require('./openbao-delivery-azure');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const REGION = /^[a-z][a-z0-9]+$/;
const API = 'https://management.azure.com';
const IDENTITY_VERSION = '2024-11-30';
const VAULT_VERSION = '2024-11-01';
const RBAC_VERSION = '2022-04-01';
const SECRETS_OFFICER = 'Key Vault Secrets Officer';
const SECRETS_USER = 'Key Vault Secrets User';

function namesFor(deployment, subscription, group) {
  if (!APP.test(deployment?.appName || '') || !['dev', 'prod'].includes(deployment.environment)
    || !GUID.test(subscription || '') || !/^[A-Za-z0-9_.()-]+$/.test(group || '')) {
    throw new Error('Paramètres Azure des identités applicatives invalides.');
  }
  const key = `${deployment.appName}/${deployment.environment}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const base = `/subscriptions/${subscription}/resourceGroups/${group}`;
  return { key, identity: `${base}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/cnp-${hash.slice(0, 20)}-vars`,
    vault: `${base}/providers/Microsoft.KeyVault/vaults/cnp${subscription.replace(/-/g, '').slice(0, 8).toLowerCase()}${hash.slice(0, 12)}` };
}

function assignmentGuid(scope, role, principal) {
  const hash = createHash('sha256').update(`${scope}/${role}/${principal}`.toLowerCase()).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function request(transport, token, method, path, data) {
  try {
    const response = await transport.request({ method, url: `${API}${path}`, data,
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000, maxRedirects: 0 });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    throw Object.assign(new Error(`Provisionnement Azure indisponible ou accès refusé${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`),
      { status: Number.isInteger(status) ? status : undefined });
  }
}

async function getOrCreate(transport, token, path, body) {
  let resource;
  try { resource = await request(transport, token, 'GET', path); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!resource) {
    try { await request(transport, token, 'PUT', path, body); }
    catch (error) { if (error.status !== 409) throw error; }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try { resource = await request(transport, token, 'GET', path); }
      catch (error) { if (error.status !== 404) throw error; }
      if (resource?.id) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (!resource?.id) throw new Error('Provisionnement Azure non confirmé.');
  return resource;
}

async function roleDefinition(transport, token, vaultId, roleName) {
  const filter = encodeURIComponent(`roleName eq '${roleName}'`);
  const result = await request(transport, token, 'GET',
    `${vaultId}/providers/Microsoft.Authorization/roleDefinitions?$filter=${filter}&api-version=${RBAC_VERSION}`);
  const matches = (result.value || []).filter(item => item.properties?.roleName === roleName);
  if (matches.length !== 1 || !matches[0].id?.startsWith('/subscriptions/')) {
    throw new Error('Définition du rôle Azure introuvable.');
  }
  return matches[0].id;
}

async function ensureAssignment(transport, token, vaultId, roleId, principal) {
  const id = assignmentGuid(vaultId, roleId, principal);
  const path = `${vaultId}/providers/Microsoft.Authorization/roleAssignments/${id}?api-version=${RBAC_VERSION}`;
  const assignment = await getOrCreate(transport, token, path, { properties: {
    roleDefinitionId: roleId, principalId: principal, principalType: 'ServicePrincipal',
  } });
  if (assignment.properties?.principalId?.toLowerCase() !== principal.toLowerCase()
    || assignment.properties?.roleDefinitionId?.toLowerCase() !== roleId.toLowerCase()) {
    throw new Error('Attribution Azure existante hors du périmètre attendu.');
  }
}

async function ensureAzureIdentity(deployment, { subscription = process.env.AZURE_SUBSCRIPTION_ID,
  group = process.env.CNP_AZURE_RUNTIME_RESOURCE_GROUP, location = process.env.AZURE_LOCATION,
  tenantId = process.env.CNP_AZURE_TENANT_ID,
  clientId = process.env.CNP_AZURE_PROVISIONER_CLIENT_ID,
  tokenFile = process.env.CNP_AZURE_FEDERATED_TOKEN_FILE,
  portalPrincipalId = process.env.CNP_AZURE_PORTAL_PRINCIPAL_ID,
  transport = axios, accessToken = federatedAccessToken } = {}) {
  const names = namesFor(deployment, subscription, group);
  if (!GUID.test(tenantId || '') || !GUID.test(clientId || '') || !GUID.test(portalPrincipalId || '')
    || !REGION.test(location || '') || !tokenFile) throw new Error('Identité Azure du provisionneur non configurée.');
  const token = await accessToken({ tenantId, clientId, tokenFile, transport,
    scope: 'https://management.azure.com/.default' });
  const identity = await getOrCreate(transport, token, `${names.identity}?api-version=${IDENTITY_VERSION}`,
    { location, tags: { cnp_environment: names.key, cnp_owner: 'openbao_runtime_provisioner' } });
  if (identity.id?.toLowerCase() !== names.identity.toLowerCase()
    || identity.tags?.cnp_environment !== names.key || !GUID.test(identity.properties?.principalId || '')) {
    throw new Error('Identité Azure existante hors du périmètre attendu.');
  }
  const vault = await getOrCreate(transport, token, `${names.vault}?api-version=${VAULT_VERSION}`,
    { location, tags: { cnp_environment: names.key, cnp_owner: 'openbao_runtime_provisioner' },
      properties: { tenantId, sku: { family: 'A', name: 'standard' }, enableRbacAuthorization: true,
        softDeleteRetentionInDays: 7, enablePurgeProtection: false } });
  if (vault.id?.toLowerCase() !== names.vault.toLowerCase()
    || vault.tags?.cnp_environment !== names.key || vault.properties?.enableRbacAuthorization !== true) {
    throw new Error('Coffre Azure existant hors du périmètre attendu.');
  }
  const officer = await roleDefinition(transport, token, names.vault, SECRETS_OFFICER);
  const user = await roleDefinition(transport, token, names.vault, SECRETS_USER);
  await ensureAssignment(transport, token, names.vault, officer, portalPrincipalId);
  await ensureAssignment(transport, token, names.vault, user, identity.properties.principalId);
  return { identity: names.identity, vault: names.vault };
}

module.exports = { namesFor, assignmentGuid, ensureAzureIdentity };
