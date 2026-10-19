'use strict';

const { randomUUID } = require('crypto');

class McpCatalog {
  constructor(client) { this.client = client; }

  async listApplications() {
    const applications = [];
    const seen = new Set();
    let cursor;
    do {
      const result = await this.client.callTool('list_applications', { limit: 100, ...(cursor ? { cursor } : {}) },
        { correlationId: randomUUID() });
      if (result.status !== 'success') throw new Error('CATALOG_UNAVAILABLE');
      applications.push(...result.data.applications);
      cursor = result.data.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('INVALID_CATALOG_CURSOR');
      if (cursor) seen.add(cursor);
      if (seen.size > 100) throw new Error('CATALOG_PAGE_LIMIT');
    } while (cursor);
    return applications;
  }
}

module.exports = { McpCatalog };
