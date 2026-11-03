'use strict';

const { describeResult } = require('../public/js/mcp-results');
const { chatEventSchema } = require('../packages/contracts/src');
const { dataMode } = require('../apps/orchestrator/src');
const { randomUUID } = require('crypto');

test('deployment view distinguishes desired/observed versions and unknown drift', () => {
  const view = describeResult('get_deployment_status', {
    applicationId: 'app', environment: 'dev', desiredState: { version: 'v2', imageDigest: null },
    observedState: { version: 'v1', imageDigest: null, healthStatus: 'Healthy', syncStatus: 'OutOfSync' },
    driftDetected: null, lastDeploymentAt: null,
  });
  expect(view.rows).toContainEqual(['Version souhaitée', 'v2']);
  expect(view.rows).toContainEqual(['Version observée', 'v1']);
  expect(view.rows).toContainEqual(['Dérive détectée', 'Indéterminée']);
});

test('logs expose source content as text and report truncation and redaction', () => {
  const view = describeResult('get_application_logs', {
    logs: [{ timestamp: '2026-01-01T00:00:00Z', level: 'ERROR', message: '<script>alert(1)</script>', version: null }],
    truncated: true, nextCursor: 'next', redactedFields: 2,
  });
  expect(view.rows[0][2]).toBe('<script>alert(1)</script>');
  expect(view.notes).toHaveLength(2);
});

test('FinOps keeps missing costs unavailable and real zero utilization visible', () => {
  const view = describeResult('get_finops_recommendation', {
    recommendation: 'INSUFFICIENT_DATA', confidence: 'low',
    utilization: { averageCpuPercent: 0, peakCpuPercent: 2, averageMemoryPercent: null, peakMemoryPercent: null },
    currentMonthlyCost: null, estimatedMonthlySavings: null, assumptions: [], risks: [], prerequisites: [], nextSteps: [],
  });
  expect(view.rows).toContainEqual(['CPU moyen (%)', '0']);
  expect(view.rows).toContainEqual(['Coût mensuel', 'Indisponible']);
  expect(view.rows).toContainEqual(['Économies estimées', 'Indisponible']);
});

test('structured event contract rejects a deployment payload disguised as application logs', () => {
  expect(chatEventSchema.safeParse({ type: 'tool_result', correlationId: randomUUID(), status: 'success',
    result: { tool: 'get_application_logs', data: { applicationId: 'app' } } }).success).toBe(false);
});

test('remote MCP sources require real user scoping without an extra data-mode flag', () => {
  expect(dataMode({ MCP_CLIENT_MODE: 'http' })).toBe('real');
  expect(dataMode({ MCP_CLIENT_MODE: 'http', MCP_DATA_MODE: 'mock' })).toBe('mock');
  expect(dataMode({ MCP_CLIENT_MODE: 'fake' })).toBe('mock');
});
