'use strict';

const { randomUUID } = require('crypto');
const metadata = require('../models/deployment_variables');
const { domainsForDeployment } = require('./openbao-routing');
const { OpenBaoClient } = require('./openbao-client');

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = /^(?:PORT|APP_PORT|DB_|DD_|CNP_)/i;
const GENERATION_KEY = 'CNP_VARIABLES_GENERATION';

function validate(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Variables invalides.');
  const entries = Object.entries(values);
  if (entries.length > 50) throw new Error('Trop de variables (maximum 50).');
  for (const [name, value] of entries) {
    if (!NAME.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)
      || RESERVED.test(name) || typeof value !== 'string' || Buffer.byteLength(value) > 8192) {
      throw new Error(`Variable invalide ou réservée : ${name}.`);
    }
  }
  return entries;
}

function service({ model = metadata, clientFor = domain => OpenBaoClient.fromEnvironment(domain), uuid = randomUUID } = {}) {
  async function prepare(deployment, values) {
    const entries = validate(values);
    if (!entries.length) return null;
    if (!deployment?.id) throw new Error('Déploiement requis pour les variables.');
    const domains = domainsForDeployment(deployment);
    const generation = uuid();
    const payload = { ...Object.fromEntries(entries), [GENERATION_KEY]: generation };
    const versions = {};
    const written = [];
    try {
      for (const domain of domains) {
        const client = clientFor(domain);
        let cas = 0;
        try { cas = (await client.read(deployment.appName, deployment.environment)).version; }
        catch (error) {
          if (error.status !== 404) throw error;
        }
        versions[domain] = await client.write(deployment.appName, deployment.environment, payload, cas);
        written.push({ domain, client, version: versions[domain] });
        const checked = await client.read(deployment.appName, deployment.environment, versions[domain]);
        if (checked.values[GENERATION_KEY] !== generation) throw new Error(`Version OpenBao ${domain} incohérente.`);
      }
      // Only the complete, verified set becomes visible to deployment reconciliation.
      model.save(deployment.id, { generation, names: entries.map(([name]) => name), versions });
    } catch (error) {
      const cleanup = await Promise.allSettled(written.map(item => item.client.destroyVersion(
        deployment.appName, deployment.environment, item.version)));
      const incomplete = cleanup.flatMap((result, index) => result.status === 'rejected' ? [written[index].domain] : []);
      if (incomplete.length) throw new Error(`Préparation OpenBao incomplète ; nettoyage provisoire impossible dans ${incomplete.join(', ')}.`);
      throw error;
    }
    return { generation, names: entries.map(([name]) => name), versions };
  }

  async function published(deployment) {
    const record = model.get(deployment.id);
    if (!record) return null;
    const domains = domainsForDeployment(deployment);
    if (Object.keys(record.versions).length !== domains.length || domains.some(domain => !record.versions[domain])) {
      throw new Error('Versions OpenBao incomplètes pour ce déploiement.');
    }
    const values = {};
    for (const domain of domains) {
      const result = await clientFor(domain).read(deployment.appName, deployment.environment, record.versions[domain]);
      if (result.values[GENERATION_KEY] !== record.generation || result.version !== record.versions[domain]) {
        throw new Error(`Version OpenBao ${domain} incohérente.`);
      }
      const selected = Object.fromEntries(Object.entries(result.values).filter(([name]) => name !== GENERATION_KEY));
      if (JSON.stringify(Object.keys(selected).sort()) !== JSON.stringify([...record.names].sort())) {
        throw new Error(`Noms de variables OpenBao ${domain} incohérents.`);
      }
      values[domain] = selected;
    }
    return { ...record, values };
  }

  return { prepare, published };
}

module.exports = { service, validate, GENERATION_KEY };
