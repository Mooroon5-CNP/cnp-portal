'use strict';

function response(tool, correlationId, data, options = {}) {
  return {
    status: options.status || 'success',
    data,
    meta: {
      tool,
      schemaVersion: '1.0',
      correlationId,
      generatedAt: new Date().toISOString(),
      sources: options.sources || [{ source: 'contract_fixture', status: 'available', retrievedAt: new Date().toISOString() }],
    },
    warnings: options.warnings || [],
    errors: options.errors || [],
  };
}

class FakeMcpClient {
  async callTool(tool, args, { correlationId }) {
    switch (tool) {
      case 'list_applications':
        return response(tool, correlationId, {
          applications: [{
            applicationId: 'majoutes-api', name: 'Majoutes API', team: 'majoutes',
            repositoryUrl: 'https://git.example/majoutes-api',
            environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: true }],
          }],
          nextCursor: null,
        }, { sources: [{ source: 'platform_api_fixture', status: 'available', retrievedAt: new Date().toISOString() }] });
      case 'get_deployment_status':
        return response(tool, correlationId, {
          applicationId: args.applicationId,
          environment: args.environment,
          desiredState: { version: '1.4.0', imageDigest: null, sourceRevision: 'fixture-revision' },
          observedState: { version: '1.4.0', imageDigest: null, syncStatus: 'Synced', healthStatus: 'Healthy' },
          driftDetected: false,
          lastDeploymentAt: null,
        }, { sources: [{ source: 'mcp_contract_fixture', status: 'available', retrievedAt: new Date().toISOString() }] });
      case 'get_application_logs':
        return response(tool, correlationId, {
          logs: [], truncated: false, redactedFields: 0,
        }, { sources: [{ source: 'datadog_fixture', status: 'available', retrievedAt: new Date().toISOString() }] });
      case 'get_finops_recommendation':
        return response(tool, correlationId, {
          recommendation: 'INSUFFICIENT_DATA',
          utilization: { averageCpuPercent: null, peakCpuPercent: null, averageMemoryPercent: null, peakMemoryPercent: null },
          currentMonthlyCost: null, estimatedTargetCost: null, estimatedMonthlySavings: null, currency: null,
          confidence: 'low', assumptions: [], risks: [], prerequisites: ['Configure workload metrics'],
          nextSteps: ['Collect CPU and memory metrics for the selected observation window'],
        }, {
          status: 'partial',
          sources: [
            { source: 'platform_api_fixture', status: 'available', retrievedAt: new Date().toISOString() },
            { source: 'cloud_billing', status: 'not_configured' },
          ],
          warnings: [{
            code: 'FINOPS_COST_DATA_UNAVAILABLE',
            message: 'No actual cost source is configured. The recommendation is based on resource utilization and workload characteristics only.',
            source: 'cloud_billing', retryable: false,
          }],
        });
      default:
        throw new Error('Tool is not approved');
    }
  }
}

module.exports = { FakeMcpClient };
