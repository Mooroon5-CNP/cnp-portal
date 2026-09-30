'use strict';

const {
  chatTurnRequestSchema,
  getApplicationLogsInputSchema,
  responseSchemas,
  toolNames,
} = require('../packages/contracts/src');

describe('MCP shared contracts', () => {
  test('exports exactly the four approved tools', () => {
    expect(toolNames).toEqual([
      'list_applications',
      'get_deployment_status',
      'get_application_logs',
      'get_finops_recommendation',
    ]);
  });

  test('rejects empty and oversized chat messages', () => {
    expect(chatTurnRequestSchema.safeParse({ message: '' }).success).toBe(false);
    expect(chatTurnRequestSchema.safeParse({ message: 'x'.repeat(4001) }).success).toBe(false);
  });

  test('rejects arbitrary Datadog syntax and log windows over 24 hours', () => {
    const base = { applicationId: 'app-api', environment: 'dev', from: '2026-01-01T00:00:00.000Z' };
    expect(getApplicationLogsInputSchema.safeParse({ ...base, to: '2026-01-02T00:00:01.000Z' }).success).toBe(false);
    expect(getApplicationLogsInputSchema.safeParse({ ...base, to: '2026-01-01T01:00:00.000Z', query: 'service:x' }).success).toBe(false);
  });

  test('requires the missing-cost warning for FinOps output', () => {
    const result = responseSchemas.get_finops_recommendation.safeParse({
      status: 'success',
      data: {
        recommendation: 'INSUFFICIENT_DATA',
        utilization: { averageCpuPercent: null, peakCpuPercent: null, averageMemoryPercent: null, peakMemoryPercent: null },
        currentMonthlyCost: null, estimatedTargetCost: null, estimatedMonthlySavings: null, currency: null,
        confidence: 'low', assumptions: [], risks: [], prerequisites: [], nextSteps: [],
      },
      meta: {
        tool: 'get_finops_recommendation', schemaVersion: '1.0', correlationId: 'test',
        generatedAt: '2026-01-01T00:00:00.000Z', sources: [],
      },
      warnings: [], errors: [],
    });
    expect(result.success).toBe(false);
  });
});
