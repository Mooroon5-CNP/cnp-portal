'use strict';

const axios = require('axios');
const express = require('express');
const fs = require('fs');
const https = require('https');
const { ensureGcpIdentity } = require('./openbao-gcp-identity');
const { ensureAzureIdentity } = require('./openbao-azure-identity');
const { ensureAwsRole } = require('./openbao-aws-identity');

const API = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || 443}`;
const SERVICE_ACCOUNT = 'system:serviceaccount:cnp-portal:cnp-portal';
const AUDIENCE = 'cnp-runtime-provisioner';
const ownTokenFile = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const ownCaFile = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

async function authorized(token, { transport = axios, readFile = fs.readFileSync } = {}) {
  const ownToken = readFile(ownTokenFile, 'utf8').trim();
  const httpsAgent = new https.Agent({ ca: readFile(ownCaFile) });
  const { data } = await transport.post(`${API}/apis/authentication.k8s.io/v1/tokenreviews`, {
    apiVersion: 'authentication.k8s.io/v1', kind: 'TokenReview', spec: { token, audiences: [AUDIENCE] },
  }, { headers: { Authorization: `Bearer ${ownToken}` }, httpsAgent, timeout: 5000, maxRedirects: 0 });
  return data?.status?.authenticated === true && data.status.user?.username === SERVICE_ACCOUNT
    && data.status.audiences?.includes(AUDIENCE);
}

const app = express();
app.use(express.json({ limit: '1kb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.post('/ensure', async (req, res) => {
  const token = req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_+./=-]+)$/)?.[1];
  if (!token) return res.status(401).json({ error: 'Identité du portail absente.' });
  try {
    if (!await authorized(token)) return res.status(403).json({ error: 'Identité du portail refusée.' });
    const deployment = req.body || {};
    if (!['gcp', 'azure'].includes(deployment.targetCluster)) return res.status(400).json({ error: 'Cloud non pris en charge.' });
    if (deployment.targetCluster === 'gcp') {
      await ensureGcpIdentity(deployment);
      // Secours AWS (GCP PostgreSQL prod) : rôle d'exécution ECS propre à l'app, créé puis relu et simulé.
      if (deployment.failoverRequested === true && deployment.environment === 'prod') await ensureAwsRole(deployment);
    } else await ensureAzureIdentity(deployment);
    return res.json({ ready: true });
  } catch (error) {
    const message = /^((Provisionnement|Identité|Compte|Paramètres|Configuration|Rôle|Isolation) [^.]{1,170}\.)$/.test(error.message)
      ? error.message : 'Provisionnement runtime indisponible. Réessayez après correction.';
    console.error('OpenBao runtime provisioner:', message);
    return res.status(503).json({ error: message });
  }
});

if (require.main === module) app.listen(3001, '0.0.0.0');
module.exports = { app, authorized };
