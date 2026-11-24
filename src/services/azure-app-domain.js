'use strict';

// Libération du nom public d'une Container App avant sa suppression (incident testapp09 dev, 24/11/2026).
// Le job de réplication lie <app>[-dev].<domaine> à un certificat géré (scripts/failover/engine/azure_domains.py). Une
// app supprimée par Crossplane avec ce nom encore lié est restée « Failed », vide, avec une suppression jamais terminée :
// Azure la croyait toujours liée au certificat (CertificateInUse) et refusait toute écriture. Avant de retirer l'app de
// Git, le portail détache donc le nom et supprime le certificat, sur une app stable (aucune opération en cours).
// Droits : rôle « CNP Container App Domain Release » du provisionneur sur le groupe des apps (cnp, azure/21-*.tf).

const axios = require('axios');
const { federatedAccessToken } = require('./openbao-delivery-azure');

const API = 'https://management.azure.com';
const VERSION = '2024-03-01';
const APP = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.App\/managedEnvironments\/[A-Za-z0-9-]+$/;

// Même règle que azure_domains.py (hostname, certificate_name).
const hostname = (app, env, domain) => (env === 'prod' ? `${app}.${domain}` : `${app}-${env}.${domain}`);
const certificateName = host => `cnp-${host.replace(/\./g, '-')}`.slice(0, 60).replace(/-+$/, '');

async function call(transport, token, method, path, data) {
  try {
    const response = await transport.request({ method, url: `${API}${path}`, data,
      headers: { Authorization: `Bearer ${token}` }, timeout: 15000, maxRedirects: 0 });
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const code = error.response?.data?.error?.code;
    throw Object.assign(new Error(`Provisionnement Azure indisponible ou accès refusé${Number.isInteger(status) ? ` (HTTP ${status})` : ''}.`),
      { status, code });
  }
}

/**
 * Renvoie { released: true } quand plus rien ne lie le nom public à l'app (ou que l'app n'existe pas), sinon
 * { released: false, reason } : l'appelant réessaie au passage suivant (rien n'est forcé sur une app occupée).
 */
async function releaseAppDomain(deployment, { environmentId = process.env.CNP_AZURE_APPS_ENVIRONMENT_ID,
  domain = process.env.AZURE_PUBLIC_DOMAIN, tenantId = process.env.CNP_AZURE_TENANT_ID,
  clientId = process.env.CNP_AZURE_PROVISIONER_CLIENT_ID, tokenFile = process.env.CNP_AZURE_FEDERATED_TOKEN_FILE,
  transport = axios, accessToken = federatedAccessToken } = {}) {
  if (!APP.test(deployment?.appName || '') || !['dev', 'prod'].includes(deployment.environment)) {
    throw new Error('Paramètres Azure de la Container App invalides.');
  }
  if (!domain) return { released: true, reason: 'no-public-domain' };
  if (!ENVIRONMENT.test(environmentId || '') || !GUID.test(tenantId || '') || !GUID.test(clientId || '') || !tokenFile) {
    throw new Error('Identité Azure du provisionneur non configurée.');
  }
  const group = environmentId.split('/providers/')[0];
  const appPath = `${group}/providers/Microsoft.App/containerApps/${deployment.appName}-${deployment.environment}?api-version=${VERSION}`;
  const host = hostname(deployment.appName, deployment.environment, domain);
  const certPath = `${environmentId}/managedCertificates/${certificateName(host)}?api-version=${VERSION}`;
  const token = await accessToken({ tenantId, clientId, tokenFile, transport, scope: `${API}/.default` });

  let app;
  try { app = await call(transport, token, 'GET', appPath); }
  catch (error) { if (error.status !== 404) throw error; }
  if (app) {
    if (app.tags?.['cnp-env'] !== deployment.environment) throw new Error('Container App existante hors du périmètre attendu.');
    // Une opération en cours (création, liaison du nom par le job) : ne rien écrire maintenant.
    if (app.properties?.provisioningState !== 'Succeeded') return { released: false, reason: `app ${app.properties?.provisioningState || 'unknown'}` };
    const ingress = app.properties.configuration?.ingress;
    const domains = ingress?.customDomains || [];
    // Seule une liaison SNI bloque la suppression ; un nom « Disabled » (re-posé par le job) n'utilise pas le certificat.
    if (domains.some(item => item.name === host && item.bindingType === 'SniEnabled')) {
      // Ingress complet renvoyé (un PATCH partiel remettrait ses autres champs à leur défaut), sans notre nom.
      const { fqdn, ...rest } = ingress; // eslint-disable-line no-unused-vars
      try {
        await call(transport, token, 'PATCH', appPath, { properties: { configuration: {
          ingress: { ...rest, customDomains: domains.filter(item => item.name !== host) } } } });
      } catch (error) {
        if (error.status === 409) return { released: false, reason: 'app busy' };
        throw error;
      }
      return { released: false, reason: 'domain detached' };
    }
  }
  // Nom détaché (ou app absente) : le certificat ne sert plus à rien ; sans lui, le job ne peut pas relier le nom.
  try { await call(transport, token, 'DELETE', certPath); }
  catch (error) {
    if (error.status === 404) return { released: true };
    if (error.status === 400 || error.status === 409) return { released: false, reason: 'certificate in use' };
    throw error;
  }
  return { released: true };
}

module.exports = { releaseAppDomain, hostname, certificateName };
