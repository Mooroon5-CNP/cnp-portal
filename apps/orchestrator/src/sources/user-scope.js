'use strict';

const { createKnownContextBuilder } = require('../context/known-context-builder');

function createUserScope(client, catalog, deployments = require('../../../../src/models/deployment'), contextOptions = {}) {
  return (user) => {
    const manager = user.role === 'manager';
    const allowed = (id, environment) => manager || deployments.listForUser(user).some(row => {
      // Flat historical deployments are dev; a missing column never grants prod.
      const selected = row.deployment_environment || 'legacy';
      return row.app_name === id && (selected === 'legacy' ? environment === 'dev' : selected === environment);
    });
    const filter = (items, environment) => items.flatMap(item => {
      const environments = (item.environments || []).filter(entry => entry.enabled
        && (!environment || entry.name === environment) && allowed(item.applicationId, entry.name));
      return environments.length ? [{ ...item, environments }] : [];
    });
    const scopedCatalog = { listApplications: async () => filter(await catalog.listApplications()) };
    const scopedClient = { callTool: async (tool, args, metadata) => {
      if (tool !== 'list_applications' && (!args.applicationId || !['dev', 'prod'].includes(args.environment)
        || !allowed(args.applicationId, args.environment))) {
        const error = new Error('FORBIDDEN'); error.code = 'FORBIDDEN'; throw error;
      }
      const result = await client.callTool(tool, args, metadata);
      if (tool === 'list_applications' && result.status !== 'error') {
        return { ...result, data: { ...result.data, applications: filter(result.data.applications, args.environment) } };
      }
      return result;
    } };
    return { catalog: scopedCatalog, mcpClient: scopedClient, buildKnownContext: createKnownContextBuilder(scopedCatalog, contextOptions) };
  };
}

module.exports = { createUserScope };
