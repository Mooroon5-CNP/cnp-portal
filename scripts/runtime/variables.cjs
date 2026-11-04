'use strict';
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');
const RESERVED = /^(PORT|HOST|DATA_DIR|DD_ENV|DD_SERVICE|DD_VERSION|LOG_LEVEL|CNP_VARIABLES_.*|CNP_OPENBAO_.*)$/;
function fail(code, status) { const error = new Error(code); error.code = code; error.status = status; return error; }
function scope(value) {
  if (!/^[a-zA-Z0-9-]{2,64}$/.test(value?.applicationId || '') || !['dev', 'prod'].includes(value?.environment)) throw fail('CONFIG_SCOPE_INVALID');
  return `${value.applicationId}/${value.environment}`;
}
function validateValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 100) throw fail('CONFIG_PAYLOAD_INVALID');
  let size = 0;
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || RESERVED.test(name) || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 32768) throw fail('CONFIG_PAYLOAD_INVALID');
    size += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (size > 65536) throw fail('CONFIG_PAYLOAD_INVALID');
  return values;
}
function reference(ref) {
  scope(ref);
  const allowed = ['schemaVersion', 'applicationId', 'environment', 'bundleId', 'provider', ...(ref.provider === 'gcs' ? ['bucket', 'object', 'generation'] : ['connection', 'mount', 'path', 'version'])];
  if (Object.keys(ref).some(key => !allowed.includes(key))) throw fail('CONFIG_REFERENCE_INVALID');
  if (ref.schemaVersion !== 1 || !/^[a-f0-9-]{36}$/.test(ref.bundleId || '')) throw fail('CONFIG_REFERENCE_INVALID');
  if (ref.provider === 'gcs') {
    if (!/^[a-z0-9][a-z0-9.-]{1,220}[a-z0-9]$/.test(ref.bucket || '') || ref.object !== `bundles/${ref.bundleId}.json` || !/^\d+$/.test(ref.generation || '')) throw fail('CONFIG_REFERENCE_INVALID');
  } else if (ref.provider === 'openbao') {
    if (ref.connection !== 'platform' || ref.mount !== 'cnp-runtime' || ref.path !== `apps/${scope(ref)}/bundles/${ref.bundleId}` || !Number.isSafeInteger(ref.version) || ref.version < 1) throw fail('CONFIG_REFERENCE_INVALID');
  } else throw fail('CONFIG_PROVIDER_INVALID');
  return ref;
}
function request(url, { method = 'GET', headers = {}, body, timeout = 3000 } = {}) {
  const target = new URL(url);
  const metadata = target.origin === 'http://metadata.google.internal';
  if ((!metadata && target.protocol !== 'https:') || target.username || target.password || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return Promise.reject(fail('CONFIG_TLS_REQUIRED'));
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = (metadata ? http : https).request(target, { method, headers: { ...headers, ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': raw.length } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 524288) res.destroy(fail('CONFIG_RESPONSE_TOO_LARGE')); else chunks.push(chunk); });
      res.on('error', () => reject(fail('CONFIG_CONNECTION_FAILED')));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(fail('CONFIG_PROVIDER_REQUEST_FAILED', res.statusCode));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(fail('CONFIG_PAYLOAD_INVALID')); }
      });
    });
    req.on('error', () => reject(fail('CONFIG_CONNECTION_FAILED')));
    req.setTimeout(timeout, () => req.destroy(fail('CONFIG_TIMEOUT')));
    // A deadline also covers connection establishment and DNS, unlike socket timeout alone.
    const timer = setTimeout(() => req.destroy(fail('CONFIG_TIMEOUT')), timeout);
    req.on('close', () => clearTimeout(timer));
    if (raw) req.write(raw); req.end();
  });
}
async function access(req = request) {
  const data = await req('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  if (!data.access_token) throw fail('CONFIG_IDENTITY_UNAVAILABLE');
  return data.access_token;
}
async function googleJWT(audience) {
  // This endpoint returns text. Use the JSON-compatible format from the metadata
  // identity response via a narrowly scoped separate reader; never accept an external URL.
  return new Promise((resolve, reject) => {
    const req = http.get(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`, { headers: { 'Metadata-Flavor': 'Google' } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; if (raw.length > 16384) res.destroy(); });
      res.on('error', () => reject(fail('CONFIG_IDENTITY_UNAVAILABLE')));
      res.on('end', () => { if (res.statusCode === 200 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(raw.trim())) resolve(raw.trim()); else reject(fail('CONFIG_IDENTITY_UNAVAILABLE')); });
    });
    const timer = setTimeout(() => req.destroy(), 3000); req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(fail('CONFIG_IDENTITY_UNAVAILABLE')));
  });
}
function baoSettings(env) {
  let url;
  try { url = new URL(env.CNP_OPENBAO_ADDR); } catch (_) { throw fail('CONFIG_OPENBAO_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw fail('CONFIG_OPENBAO_NOT_CONFIGURED');
  return { origin: url.origin, audience: env.CNP_OPENBAO_AUDIENCE || url.origin };
}
function createClient({ req = request, getAccess = () => access(req), getJWT = googleJWT, env = process.env } = {}) {
  async function bao(role) {
    const settings = baoSettings(env);
    const jwt = await getJWT(settings.audience);
    const data = await req(`${settings.origin}/v1/auth/jwt/login`, { method: 'POST', body: { role, jwt } });
    if (!data.auth?.client_token) throw fail('CONFIG_IDENTITY_UNAVAILABLE');
    return { origin: settings.origin, headers: { 'X-Vault-Token': data.auth.client_token } };
  }
  async function gcsHeaders() { return { Authorization: `Bearer ${await getAccess()}` }; }
  async function writeBundle(target, values, provider, options = {}) {
    validateValues(values); scope(target);
    const bundleId = options.bundleId || randomUUID();
    const base = { schemaVersion: 1, applicationId: target.applicationId, environment: target.environment, bundleId };
    const payload = { ...base, values };
    if (provider === 'gcs') {
      const ref = { ...base, provider, bucket: options.bucket, object: `bundles/${bundleId}.json`, generation: '0' }; reference(ref);
      const headers = await gcsHeaders();
      // JSON API media upload: body is JSON data, not a shell/env file.
      const result = await req(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(ref.bucket)}/o?uploadType=media&name=${encodeURIComponent(ref.object)}&ifGenerationMatch=0`, { method: 'POST', headers, body: payload });
      if (typeof result.generation !== 'string') throw fail('CONFIG_REFERENCE_INVALID');
      return reference({ ...ref, generation: result.generation });
    }
    if (provider !== 'openbao') throw fail('CONFIG_PROVIDER_INVALID');
    const ref = { ...base, provider, connection: 'platform', mount: 'cnp-runtime', path: `apps/${scope(base)}/bundles/${bundleId}`, version: 1 };
    const auth = await bao(env.CNP_OPENBAO_CONTROL_ROLE || 'cnp-control');
    const result = await req(`${auth.origin}/v1/${ref.mount}/data/${ref.path}`, { method: 'POST', headers: auth.headers, body: { options: { cas: 0 }, data: payload } });
    return reference({ ...ref, version: result.data?.version });
  }
  async function readBundle(ref, control = false) {
    reference(ref); let payload;
    if (ref.provider === 'gcs') {
      payload = await req(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(ref.bucket)}/o/${encodeURIComponent(ref.object)}?alt=media&generation=${encodeURIComponent(ref.generation)}`, { headers: await gcsHeaders() });
    } else {
      const auth = await bao(control ? env.CNP_OPENBAO_CONTROL_ROLE || 'cnp-control' : `cnp-${ref.applicationId}-${ref.environment}`);
      const result = await req(`${auth.origin}/v1/${ref.mount}/data/${ref.path}?version=${ref.version}`, { headers: auth.headers });
      if (result.data?.metadata?.version !== ref.version || result.data?.metadata?.destroyed || result.data?.metadata?.deletion_time) throw fail('CONFIG_VERSION_UNAVAILABLE');
      payload = result.data?.data;
    }
    if (payload?.schemaVersion !== 1 || payload.applicationId !== ref.applicationId || payload.environment !== ref.environment || payload.bundleId !== ref.bundleId) throw fail('CONFIG_SCOPE_MISMATCH');
    return validateValues(payload.values);
  }
  return { writeBundle, readBundle, bao };
}
module.exports = { createClient, reference, validateValues, scope, baoSettings, request, googleJWT, fail };
