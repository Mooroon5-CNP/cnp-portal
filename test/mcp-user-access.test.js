'use strict';

const express = require('express');
const request = require('supertest');
const { buildOrchestratorRouter } = require('../apps/orchestrator/src');
const { createUserScope } = require('../apps/orchestrator/src/sources/user-scope');

test('dev access cannot disclose or query prod, including direct calls and cached catalog entries', async () => {
  const application = { applicationId: 'mine', environments: [
    { name: 'dev', enabled: true }, { name: 'prod', enabled: true },
  ] };
  let rows = [{ app_name: 'mine', deployment_environment: 'dev' }];
  const client = { callTool: jest.fn(async () => ({ status: 'success', data: { applications: [application] } })) };
  const scope = createUserScope(client, { listApplications: async () => [application] },
    { listForUser: () => rows })({ id: 'developer', role: 'dev' });
  expect((await scope.catalog.listApplications())[0].environments.map(entry => entry.name)).toEqual(['dev']);
  for (const tool of ['get_deployment_status', 'get_application_logs', 'get_finops_recommendation']) {
    await expect(scope.mcpClient.callTool(tool, { applicationId: 'mine', environment: 'prod' }, {}))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  }
  expect(client.callTool).not.toHaveBeenCalled();
  const result = await scope.mcpClient.callTool('list_applications', {}, {});
  expect(result.data.applications[0].environments).toEqual([{ name: 'dev', enabled: true }]);
  rows = [];
  expect(await scope.catalog.listApplications()).toEqual([]);
  await expect(scope.mcpClient.callTool('get_deployment_status', { applicationId: 'mine', environment: 'dev' }, {}))
    .rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(application.environments).toHaveLength(2);
});

test('prod-only grants, legacy grants and manager visibility remain distinct', async () => {
  const app = { applicationId: 'mine', environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: true }] };
  for (const [environment, role, expected] of [['prod', 'dev', ['prod']], ['legacy', 'dev', ['dev']],
    ['unexpected', 'dev', []], ['dev', 'manager', ['dev', 'prod']]]) {
    const scope = createUserScope({ callTool: jest.fn() }, { listApplications: async () => [app] },
      { listForUser: () => [{ app_name: 'mine', deployment_environment: environment }] })({ id: 'user', role });
    const result = await scope.catalog.listApplications();
    expect(result.flatMap(item => item.environments.map(entry => entry.name))).toEqual(expected);
  }
});

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
