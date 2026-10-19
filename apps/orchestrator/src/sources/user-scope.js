'use strict';

const { createKnownContextBuilder } = require('../context/known-context-builder');

function createUserScope(client, catalog, deployments = require('../../../../src/models/deployment'), contextOptions = {}) {
  return (user) => {
    const accessible = () => new Set(deployments.listForUser(user).map((row) => row.app_name));
    const manager = user.role === 'manager';
    const permitted = (id) => manager || accessible().has(id);
    const scopedCatalog = { listApplications: async () => (await catalog.listApplications()).filter((item) => permitted(item.applicationId)) };
    const scopedClient = { callTool: async (tool, args, metadata) => {
      if (args.applicationId && !permitted(args.applicationId)) {
        const error = new Error('FORBIDDEN'); error.code = 'FORBIDDEN'; throw error;
      }
      const result = await client.callTool(tool, args, metadata);
      if (tool === 'list_applications' && result.status !== 'error') {
        return { ...result, data: { ...result.data, applications: result.data.applications.filter((item) => permitted(item.applicationId)) } };
      }
      return result;
    } };
    return { catalog: scopedCatalog, mcpClient: scopedClient, buildKnownContext: createKnownContextBuilder(scopedCatalog, contextOptions) };
  };
}

module.exports = { createUserScope };
