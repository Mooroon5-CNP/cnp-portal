'use strict';

const { probeCatalog } = require('../scripts/lib/catalog-probe.cjs');
const { McpCatalog } = require('../apps/orchestrator/src/catalog/mcp-catalog');
const { describeError } = require('../apps/orchestrator/src/http/router');

test.each(['SOURCE_TIMEOUT', 'SOURCE_UNAVAILABLE', 'SOURCE_NOT_CONFIGURED', 'SOURCE_RESPONSE_INVALID'])(
  'startup continues with a degraded catalog for %s', async code => {
    const client = { callTool: jest.fn().mockResolvedValue({ status: 'error', errors: [{ code }] }) };
    await expect(probeCatalog(client, { correlationId: 'startup' })).resolves.toEqual({ available: false, code });
    expect(client.callTool).toHaveBeenCalledWith('list_applications', { limit: 20 }, { correlationId: 'startup' });
  },
);
test('available catalog passes the startup probe', async () => {
  await expect(probeCatalog({ callTool: async () => ({ status: 'success' }) }, {})).resolves.toEqual({ available: true });
});
test.each(['FORBIDDEN', 'UNAUTHENTICATED', 'INTERNAL_ERROR', 'INVALID_INPUT'])(
  '%s still prevents startup', async code => {
    await expect(probeCatalog({ callTool: async () => ({ status: 'error', errors: [{ code }] }) }, {})).rejects.toThrow('MCP catalog probe failed');
  },
);
test('transport failures still prevent startup', async () => {
  await expect(probeCatalog({ callTool: async () => { throw new Error('MCP_UNAUTHENTICATED'); } }, {})).rejects.toThrow('MCP_UNAUTHENTICATED');
});
test('source outages become an actionable catalog error, never an empty healthy list', async () => {
  const catalog = new McpCatalog({ callTool: async () => ({ status: 'error', errors: [{ code: 'SOURCE_TIMEOUT' }] }) });
  await expect(catalog.listApplications()).rejects.toMatchObject({ code: 'MCP_CATALOG_UNAVAILABLE' });
  expect(describeError({ code: 'MCP_CATALOG_UNAVAILABLE' })).toContain('GitHub');
});
