'use strict';

const express = require('express');
const request = require('supertest');
const { buildOrchestratorRouter } = require('../apps/orchestrator/src');

test('HTTP MCP applies portal permissions even without MCP_DATA_MODE', async () => {
  const oldMode = process.env.MCP_CLIENT_MODE;
  const oldData = process.env.MCP_DATA_MODE;
  process.env.MCP_CLIENT_MODE = 'http';
  delete process.env.MCP_DATA_MODE;
  try {
    const applications = ['mine', 'another-team'].map(applicationId => ({ applicationId, name: applicationId,
      team: 'platform', repositoryUrl: 'https://example.test/repo', environments: [{ name: 'dev', enabled: true }] }));
    const app = express();
    app.use((req, _res, next) => { req.user = { id: 'developer', role: req.get('x-test-role') || 'dev' }; next(); });
    app.use(buildOrchestratorRouter({ requireAuth: (_req, _res, next) => next(),
      mcpClient: { callTool: jest.fn() }, catalog: { listApplications: async () => applications },
      deployments: { listForUser: () => [{ app_name: 'mine' }] },
    }));
    const developer = await request(app).get('/api/v1/mcp/catalog').expect(200);
    expect(developer.body.applications.map(item => item.applicationId)).toEqual(['mine']);
    const manager = await request(app).get('/api/v1/mcp/catalog').set('x-test-role', 'manager').expect(200);
    expect(manager.body.applications).toHaveLength(2);
  } finally {
    if (oldMode === undefined) delete process.env.MCP_CLIENT_MODE; else process.env.MCP_CLIENT_MODE = oldMode;
    if (oldData === undefined) delete process.env.MCP_DATA_MODE; else process.env.MCP_DATA_MODE = oldData;
  }
});
