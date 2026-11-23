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
    const scopedClient = { callTool: async (tool, args, metadata = {}) => {
      // Gemini Cloud Assist may run without a CNP target; a target, when given, is checked like any other tool.
      const targetless = tool === 'list_applications' || (tool === 'gcp_cloud_assist' && !args.applicationId && !args.environment);
      if (!targetless && (!args.applicationId || !['dev', 'prod'].includes(args.environment)
        || !allowed(args.applicationId, args.environment))) {
        const error = new Error('FORBIDDEN'); error.code = 'FORBIDDEN'; throw error;
      }
      const authorizedTarget = targetless ? undefined : { applicationId: args.applicationId, environment: args.environment };
      const result = await client.callTool(tool, args, { ...metadata, ...(authorizedTarget ? { authorizedTarget } : {}) });
      if (tool === 'list_applications' && result.status !== 'error') {
        return { ...result, data: { ...result.data, applications: filter(result.data.applications, args.environment) } };
      }
      return result;
    } };
    return { catalog: scopedCatalog, mcpClient: scopedClient, buildKnownContext: createKnownContextBuilder(scopedCatalog, contextOptions) };
  };
}

module.exports = { createUserScope };
