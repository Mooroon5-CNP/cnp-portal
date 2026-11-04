'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
let cached;
async function token() {
  if (cached && cached.until > Date.now() + 60000) return cached.value;
  try {
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS verification required');
    const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(os.homedir(), '.config/gcloud/application_default_credentials.json');
    let credentials;
    try { credentials = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' || process.env.GOOGLE_APPLICATION_CREDENTIALS) throw error; }
    let data; let principal;
    if (credentials) {
      const form = new URLSearchParams();
      if (credentials.type === 'authorized_user') {
        principal = { kind: 'authorized_user', email: null };
        for (const key of ['client_id', 'client_secret', 'refresh_token']) form.set(key, credentials[key]);
        form.set('grant_type', 'refresh_token');
      } else if (credentials.type === 'service_account') {
        principal = { kind: 'service_account', email: credentials.client_email };
        const now = Math.floor(Date.now() / 1000);
        const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        const payload = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iss: credentials.client_email,
          scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
        form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
        form.set('assertion', `${payload}.${crypto.sign('RSA-SHA256', Buffer.from(payload), credentials.private_key).toString('base64url')}`);
      } else throw new Error('Unsupported ADC format');
      ({ data } = await axios.post('https://oauth2.googleapis.com/token', form.toString(), { timeout: 10000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
    } else {
      ({ data } = await axios.get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        timeout: 3000, proxy: false, headers: { 'Metadata-Flavor': 'Google' }, maxRedirects: 0,
      }));
    }
    if (!principal) {
      const email = await axios.get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email', {
        timeout: 3000, proxy: false, headers: { 'Metadata-Flavor': 'Google' }, maxRedirects: 0,
      });
      principal = { kind: 'metadata', email: String(email.data).trim() };
    }
    if (principal.kind !== 'authorized_user' && !/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(principal.email || '')) throw new Error('Invalid platform identity');
    if (!data.access_token || !data.expires_in) throw new Error('Missing token');
    const quotaProject = credentials?.quota_project_id;
    if (quotaProject && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(quotaProject)) throw new Error('Invalid quota project');
    cached = { principal, quotaProject, value: data.access_token, until: Date.now() + Number(data.expires_in) * 1000 };
    return cached.value;
  } catch (_) { throw new Error('Identité GCP du portail indisponible. Configurez son compte de service ou les ADC côté plateforme.'); }
}
async function identity() { await token(); return { ...cached.principal }; }
async function headers() {
  const value = await token();
  return { Authorization: `Bearer ${value}`, ...(cached.quotaProject ? { 'x-goog-user-project': cached.quotaProject } : {}) };
}
module.exports = { token, identity, headers };
