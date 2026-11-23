'use strict';

jest.mock('axios', () => {
  const get = jest.fn();
  return { create: jest.fn(() => ({ get })), __get: get };
});
const axios = require('axios');
const { queryMcpMetrics, mcpMetricsScope } = require('../src/clients/datadog');

const ENV = ['MCP_CPU_PERCENT_METRIC', 'MCP_MEMORY_PERCENT_METRIC', 'MCP_METRICS_SCOPE', 'MCP_METRICS_RATIO', 'DD_API_KEY', 'DD_APP_KEY'];
const saved = {};
beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  Object.assign(process.env, { DD_API_KEY: 'k', DD_APP_KEY: 'a',
    MCP_CPU_PERCENT_METRIC: 'gcp.run.container.cpu.utilizations.avg', MCP_MEMORY_PERCENT_METRIC: 'gcp.run.container.memory.utilizations.avg' });
  delete process.env.MCP_METRICS_SCOPE; delete process.env.MCP_METRICS_RATIO;
  axios.__get.mockReset();
});
afterEach(() => { for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });

const day = 86400000;
const series = (values) => ({ data: { series: [{ pointlist: values.map((value, index) => [Date.parse('2026-11-16T00:00:00Z') + index * day, value]) }] } });

test('keeps the historical APM scope and percent values by default', async () => {
  axios.__get.mockResolvedValue(series([10, 30]));
  const result = await queryMcpMetrics('app-2-dancingduck', 'dev', 7);
  expect(axios.__get).toHaveBeenCalledWith('/api/v1/query', expect.objectContaining({ params: expect.objectContaining({
    query: 'avg:gcp.run.container.cpu.utilizations.avg{service:app-2-dancingduck,env:dev}' }) }));
  expect(result).toMatchObject({ averageCpuPercent: 20, peakCpuPercent: 30 });
});

test('queries Cloud Run integration metrics by service_name and converts ratios to percent', async () => {
  process.env.MCP_METRICS_SCOPE = 'service_name:{app}-{env}';
  process.env.MCP_METRICS_RATIO = 'true';
  axios.__get.mockResolvedValue(series([0.02, 0.04, 0.03]));
  const result = await queryMcpMetrics('app-2-dancingduck', 'prod', 7);
  expect(axios.__get).toHaveBeenCalledWith('/api/v1/query', expect.objectContaining({ params: expect.objectContaining({
    query: 'avg:gcp.run.container.memory.utilizations.avg{service_name:app-2-dancingduck-prod}' }) }));
  expect(result.averageCpuPercent).toBeCloseTo(3);
  expect(result.peakCpuPercent).toBeCloseTo(4);
  expect(result.coverageDays).toBe(2);
});

test('refuses unsafe scopes and inputs', async () => {
  expect(() => mcpMetricsScope('app', 'dev', 'service:{app} OR *')).toThrow('INVALID_METRIC_SCOPE');
  expect(() => mcpMetricsScope('app', 'dev', 'env:{env}')).toThrow('INVALID_METRIC_SCOPE');
  await expect(queryMcpMetrics('app', 'staging', 7)).rejects.toThrow('INVALID_INPUT');
  await expect(queryMcpMetrics('app}{*', 'dev', 7)).rejects.toThrow('INVALID_INPUT');
});
