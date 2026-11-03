'use strict';

const sourceFailures = new Set(['SOURCE_TIMEOUT', 'SOURCE_UNAVAILABLE', 'SOURCE_NOT_CONFIGURED', 'SOURCE_RESPONSE_INVALID']);

// A source outage must not stop the portal; identity/protocol failures still abort.
async function probeCatalog(client, metadata) {
  const result = await client.callTool('list_applications', { limit: 20 }, metadata);
  if (result.status === 'success') return { available: true };
  if (result.status === 'error' && result.errors?.length
    && result.errors.every(issue => sourceFailures.has(issue.code))) {
    return { available: false, code: result.errors[0].code };
  }
  throw new Error('MCP catalog probe failed: authentication, authorization or contract error.');
}
module.exports = { probeCatalog };
