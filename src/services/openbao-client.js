'use strict';

const axios = require('axios');
const fs = require('fs');
const https = require('https');

const APP = /^[a-z][a-z0-9-]{1,39}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SEGMENT = /^[a-z][a-z0-9-]*$/;

function safePath(app, environment) {
  if (!APP.test(app) || !['dev', 'prod'].includes(environment)) {
    throw new Error('Chemin de variables OpenBao invalide.');
  }
  return `apps/${app}/${environment}`;
}

async function googleIdentityToken(audience, transport = axios) {
  const { data } = await transport.get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity', {
    headers: { 'Metadata-Flavor': 'Google' }, params: { audience, format: 'full' }, timeout: 5000,
  });
  if (typeof data !== 'string' || !data) throw new Error('Identité du portail indisponible.');
  return data;
}

class OpenBaoClient {
  constructor({ domain, address, audience = address, role = 'cnp-control', mount = 'cnp-runtime', caFile,
    transport = axios, identityToken = googleIdentityToken }) {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Adresse OpenBao HTTPS invalide.');
    }
    if (!['gcp', 'aws', 'azure'].includes(domain) || !SEGMENT.test(mount) || !SEGMENT.test(role)) {
      throw new Error('Configuration OpenBao invalide.');
    }
    this.domain = domain;
    this.address = url.origin;
    this.audience = audience;
    this.role = role;
    this.mount = mount;
    this.transport = transport;
    this.identityToken = identityToken;
    this.httpsAgent = caFile ? new https.Agent({ ca: fs.readFileSync(caFile) }) : undefined;
  }

  static fromEnvironment(domain, dependencies = {}) {
    if (!['gcp', 'aws', 'azure'].includes(domain)) throw new Error('Domaine OpenBao invalide.');
    const prefix = `CNP_OPENBAO_${domain.toUpperCase()}_`;
    const address = process.env[`${prefix}ADDR`];
    if (!address) throw new Error(`Adresse OpenBao ${domain} manquante.`);
    return new OpenBaoClient({ domain, address, audience: process.env[`${prefix}AUDIENCE`] || address,
      role: process.env[`${prefix}ROLE`] || 'cnp-control', mount: process.env[`${prefix}MOUNT`] || 'cnp-runtime',
      caFile: process.env[`${prefix}CA_FILE`], ...dependencies });
  }

  async request(method, path, data, params, endpoint = 'data') {
    if (!['data', 'destroy'].includes(endpoint)) throw new Error('Endpoint OpenBao invalide.');
    try {
      const jwt = await this.identityToken(this.audience, this.transport);
      const options = { timeout: 5000, maxRedirects: 0, httpsAgent: this.httpsAgent };
      const login = await this.transport.post(`${this.address}/v1/auth/jwt/login`, { role: this.role, jwt }, options);
      const token = login.data?.auth?.client_token;
      if (typeof token !== 'string' || !token) throw new Error('Token OpenBao absent.');
      const response = await this.transport.request({ ...options, method,
        url: `${this.address}/v1/${this.mount}/${endpoint}/${path}`, headers: { 'X-Vault-Token': token }, data, params });
      return response.data;
    } catch (error) {
      // Axios errors can embed the request (and its secret body). Never propagate them.
      const code = error.response?.status;
      const status = Number.isInteger(code) ? ` (HTTP ${code})` : '';
      throw Object.assign(new Error(`OpenBao ${this.domain} indisponible ou accès refusé${status}.`),
        { status: Number.isInteger(code) ? code : undefined });
    }
  }

  async read(app, environment, version) {
    const path = safePath(app, environment);
    if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error('Version OpenBao invalide.');
    const result = await this.request('GET', path, undefined, version ? { version } : undefined);
    const values = result?.data?.data;
    const actualVersion = result?.data?.metadata?.version;
    if (!values || typeof values !== 'object' || Array.isArray(values) || !Number.isInteger(actualVersion)) {
      throw new Error(`Réponse OpenBao ${this.domain} invalide.`);
    }
    return { values, version: actualVersion };
  }

  async write(app, environment, values, cas) {
    const path = safePath(app, environment);
    if (!Number.isInteger(cas) || cas < 0 || !values || typeof values !== 'object' || Array.isArray(values)
      || Object.entries(values).some(([key, value]) => !KEY.test(key) || typeof value !== 'string')) {
      throw new Error('Variables ou version attendue invalides.');
    }
    const result = await this.request('POST', path, { options: { cas }, data: values });
    const version = result?.data?.version;
    if (!Number.isInteger(version) || version < 1) throw new Error(`Réponse OpenBao ${this.domain} invalide.`);
    return version;
  }

  async destroyVersion(app, environment, version) {
    const path = safePath(app, environment);
    if (!Number.isInteger(version) || version < 1) throw new Error('Version OpenBao invalide.');
    await this.request('POST', path, { versions: [version] }, undefined, 'destroy');
  }
}

module.exports = { OpenBaoClient, googleIdentityToken, safePath };
