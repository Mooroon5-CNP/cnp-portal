'use strict';

const { z } = require('zod');

const schemaVersion = '1.0';
const toolNames = Object.freeze([
  'list_applications',
  'get_deployment_status',
  'get_application_logs',
  'get_finops_recommendation',
]);
const errorCodes = Object.freeze([
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'APPLICATION_NOT_FOUND',
  'ENVIRONMENT_NOT_FOUND', 'SOURCE_UNAVAILABLE', 'SOURCE_TIMEOUT', 'RATE_LIMITED',
  'OBSERVABILITY_NOT_CONFIGURED', 'FINOPS_COST_DATA_UNAVAILABLE',
  'INSUFFICIENT_METRICS', 'UNSUPPORTED_REQUEST', 'TLS_REQUIRED',
  'TLS_CERTIFICATE_INVALID', 'ORIGIN_NOT_ALLOWED', 'INTERNAL_ERROR',
]);

const timestampSchema = z.iso.datetime();
const identifierSchema = z.string().min(1).max(200);
const environmentSchema = z.enum(['dev', 'prod']);
const targetShape = { applicationId: identifierSchema, environment: environmentSchema };

const listApplicationsInputSchema = z.strictObject({
  query: z.string().max(200).optional(),
  environment: environmentSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1000).optional(),
});
const getDeploymentStatusInputSchema = z.strictObject(targetShape);
const getApplicationLogsInputSchema = z.strictObject({
  ...targetShape,
  from: timestampSchema,
  to: timestampSchema.default(() => new Date().toISOString()),
  levels: z.array(z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR'])).max(4).optional(),
  query: z.string().max(200)
    .regex(/^[\p{L}\p{N}\s._-]*$/u, 'Only plain search text is allowed')
    .refine((value) => !/\b(?:AND|OR|NOT)\b/.test(value), 'Query operators are forbidden')
    .optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().max(1000).optional(),
}).refine((value) => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  return duration >= 0 && duration <= 24 * 60 * 60 * 1000;
}, { message: 'Log window must be ordered and at most 24 hours', path: ['to'] });
const getFinOpsRecommendationInputSchema = z.strictObject({
  ...targetShape,
  observationWindowDays: z.union([z.literal(7), z.literal(14), z.literal(30)]).optional(),
});
const inputSchemas = Object.freeze({
  list_applications: listApplicationsInputSchema,
  get_deployment_status: getDeploymentStatusInputSchema,
  get_application_logs: getApplicationLogsInputSchema,
  get_finops_recommendation: getFinOpsRecommendationInputSchema,
});

const applicationSchema = z.strictObject({
  applicationId: identifierSchema,
  name: z.string(),
  team: z.string(),
  repositoryUrl: z.string(),
  environments: z.array(z.strictObject({ name: environmentSchema, enabled: z.boolean() })),
});
const listApplicationsDataSchema = z.strictObject({
  applications: z.array(applicationSchema),
  nextCursor: z.string().nullable(),
});
const getDeploymentStatusDataSchema = z.strictObject({
  ...targetShape,
  desiredState: z.strictObject({
    version: z.string().nullable(), imageDigest: z.string().nullable(), sourceRevision: z.string().nullable(),
  }),
  observedState: z.strictObject({
    version: z.string().nullable(), imageDigest: z.string().nullable(),
    syncStatus: z.enum(['Synced', 'OutOfSync', 'Unknown']),
    healthStatus: z.enum(['Healthy', 'Progressing', 'Degraded', 'Unknown']),
  }),
  driftDetected: z.boolean().nullable(),
  lastDeploymentAt: timestampSchema.nullable(),
});
const logSchema = z.strictObject({
  timestamp: timestampSchema,
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'UNKNOWN']),
  message: z.string(), service: z.string(), version: z.string().nullable(), correlationId: z.string().nullable(),
});
const getApplicationLogsDataSchema = z.strictObject({
  logs: z.array(logSchema).max(200), nextCursor: z.string().nullable(), truncated: z.boolean(), redactedFields: z.number().int().nonnegative(),
});
const getFinOpsRecommendationDataSchema = z.strictObject({
  recommendation: z.enum([
    'KEEP_CURRENT_CONFIGURATION', 'RESIZE_RESOURCES', 'EVALUATE_CLOUD_RUN',
    'EVALUATE_GKE', 'INSUFFICIENT_DATA',
  ]),
  utilization: z.strictObject({
    averageCpuPercent: z.number().nullable(), peakCpuPercent: z.number().nullable(),
    averageMemoryPercent: z.number().nullable(), peakMemoryPercent: z.number().nullable(),
  }),
  currentMonthlyCost: z.null(), estimatedTargetCost: z.null(),
  estimatedMonthlySavings: z.null(), currency: z.null(),
  confidence: z.enum(['low', 'medium', 'high']),
  assumptions: z.array(z.string()), risks: z.array(z.string()),
  prerequisites: z.array(z.string()), nextSteps: z.array(z.string()),
});
const dataSchemas = Object.freeze({
  list_applications: listApplicationsDataSchema,
  get_deployment_status: getDeploymentStatusDataSchema,
  get_application_logs: getApplicationLogsDataSchema,
  get_finops_recommendation: getFinOpsRecommendationDataSchema,
});

const sourceStatusSchema = z.strictObject({
  source: z.string().min(1),
  status: z.enum(['available', 'unavailable', 'not_configured']),
  retrievedAt: timestampSchema.optional(),
});
const toolIssueSchema = z.strictObject({
  code: z.string().min(1), message: z.string().min(1), source: z.string().optional(), retryable: z.boolean(),
});

function responseSchema(tool, dataSchema) {
  const common = {
    meta: z.strictObject({
      tool: z.literal(tool), schemaVersion: z.literal(schemaVersion),
      correlationId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/), generatedAt: timestampSchema,
      sources: z.array(sourceStatusSchema),
    }),
    warnings: z.array(toolIssueSchema),
    errors: z.array(toolIssueSchema),
  };
  return z.discriminatedUnion('status', [
    z.strictObject({ ...common, status: z.literal('success'), data: dataSchema }),
    z.strictObject({ ...common, status: z.literal('partial'), data: dataSchema, warnings: z.array(toolIssueSchema).min(1) }),
    z.strictObject({ ...common, status: z.literal('error'), data: z.null(), errors: z.array(toolIssueSchema).min(1) }),
  ]);
}

const responseSchemas = Object.freeze({
  list_applications: responseSchema('list_applications', listApplicationsDataSchema),
  get_deployment_status: responseSchema('get_deployment_status', getDeploymentStatusDataSchema),
  get_application_logs: responseSchema('get_application_logs', getApplicationLogsDataSchema),
  get_finops_recommendation: responseSchema('get_finops_recommendation', getFinOpsRecommendationDataSchema)
    .refine((response) => response.status === 'error'
      || (response.status === 'partial'
        && response.warnings.some((warning) => warning.code === 'FINOPS_COST_DATA_UNAVAILABLE')),
    'FinOps requires partial status and the missing-cost warning'),
});

// Gemini Cloud Assist (mirror of MCP-CNP packages/contracts). Mandatory 7-section diagnostic answer.
const text = (max) => z.string().min(1).max(max);
const answerSourceSchema = z.string().min(1).max(64).regex(/^[a-z_]+$/);
const correlationIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const diagnosticAnswerSchema = z.strictObject({
  summary: text(2000),
  observations: z.array(z.strictObject({ source: answerSourceSchema, fact: text(8000), resource: z.string().max(500).nullable(), observedAt: timestampSchema.nullable() })).max(50),
  diagnosis: z.array(z.strictObject({ kind: z.enum(['fact', 'hypothesis']), statement: text(4000) })).max(30),
  evidence: z.array(z.strictObject({
    source: answerSourceSchema, resource: z.string().max(500).nullable(),
    period: z.strictObject({ from: timestampSchema, to: timestampSchema }).nullable(), observedAt: timestampSchema.nullable(), values: z.string().max(2000).nullable(),
  })).max(50),
  recommendations: z.array(z.strictObject({ priority: z.number().int().min(1).max(10), action: text(2000), executed: z.literal(false) })).max(20),
  confidence: z.strictObject({ level: z.enum(['high', 'medium', 'low']), justification: text(1000) }),
  limitations: z.array(text(1000)).max(30),
});
/** A source may be cited only if it was actually called and answered. */
function citesOnlyCalledSources(answer, sources) {
  const available = new Set(sources.filter((source) => source.status === 'available').map((source) => source.source));
  return [...answer.observations, ...answer.evidence].every((item) => available.has(item.source));
}
const gcaCapabilities = Object.freeze(['ask_cloud_assist', 'investigate_issue', 'optimize_costs']);
const gcpCloudAssistToolName = 'gcp_cloud_assist';
const gcpCloudAssistInputSchema = z.strictObject({
  capability: z.enum(gcaCapabilities), question: z.string().min(1).max(4000), conversationId: correlationIdSchema,
  applicationId: identifierSchema.optional(), environment: environmentSchema.optional(),
});
const gcpCloudAssistDataSchema = z.strictObject({
  capability: z.enum(gcaCapabilities), conversationId: correlationIdSchema, sessionContinued: z.boolean(),
  structured: z.boolean(), actionProposed: z.boolean(), answer: diagnosticAnswerSchema,
});
const gcpCloudAssistResponseSchema = responseSchema(gcpCloudAssistToolName, gcpCloudAssistDataSchema)
  .refine((response) => response.status === 'error' || citesOnlyCalledSources(response.data.answer, response.meta.sources),
    'An answer may only cite sources that were actually called');
const chatToolNames = Object.freeze([...toolNames, gcpCloudAssistToolName]);

const chatTurnRequestSchema = z.strictObject({
  conversationId: z.string().uuid().optional(),
  message: z.string().trim().min(1).max(4000),
  context: z.strictObject({
    applicationId: identifierSchema.optional(),
    environment: z.string().min(1).max(40).optional(),
    openPage: z.enum(['applications_list', 'application_overview', 'deployment', 'logs', 'finops', 'unknown']).optional(),
    selectedTab: z.string().min(1).max(100).optional(),
    timeRange: z.strictObject({ from: z.string().max(100), to: z.string().max(100) }).optional(),
    filters: z.strictObject({
      logLevel: z.array(z.string().max(40)).max(10).optional(),
      deploymentStatus: z.array(z.string().max(80)).max(20).optional(),
      search: z.string().max(200).optional(),
    }).optional(),
    language: z.string().max(20).optional(),
    timezone: z.string().max(100).optional(),
  }).optional(),
});
const sourceSummarySchema = z.strictObject({ source: z.string(), status: z.string() });
const eventBase = { correlationId: z.string().uuid() };
const chatEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...eventBase, type: z.literal('turn_started'), conversationId: z.string().uuid() }),
  z.strictObject({ ...eventBase, type: z.literal('clarification_required'), question: z.string().min(1) }),
  z.strictObject({ ...eventBase, type: z.literal('tool_started'), tool: z.enum(chatToolNames) }),
  z.strictObject({ ...eventBase, type: z.literal('tool_completed'), tool: z.enum(chatToolNames), status: z.enum(['success', 'partial', 'error']) }),
  z.strictObject({ ...eventBase, type: z.literal('tool_result'), status: z.enum(['success', 'partial']), result: z.discriminatedUnion('tool',
    toolNames.map(tool => z.strictObject({ tool: z.literal(tool), data: dataSchemas[tool] }))) }),
  z.strictObject({ ...eventBase, type: z.literal('diagnostic_answer'), answer: diagnosticAnswerSchema, sources: z.array(sourceSummarySchema) }),
  z.strictObject({ ...eventBase, type: z.literal('warning'), code: z.string(), message: z.string() }),
  z.strictObject({ ...eventBase, type: z.literal('answer_delta'), text: z.string() }),
  z.strictObject({ ...eventBase, type: z.literal('turn_completed'), sources: z.array(sourceSummarySchema) }),
  z.strictObject({ ...eventBase, type: z.literal('error'), code: z.string(), message: z.string(), retryable: z.boolean() }),
]);

function getInputJsonSchema(tool) {
  if (!toolNames.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
  return z.toJSONSchema(inputSchemas[tool], { io: 'input' });
}

function getOutputJsonSchema(tool) {
  if (!toolNames.includes(tool)) throw new Error(`Unknown tool: ${tool}`);
  return { ...z.toJSONSchema(responseSchemas[tool]), type: 'object' };
}

module.exports = {
  schemaVersion, toolNames, errorCodes, environmentSchema,
  listApplicationsInputSchema, getDeploymentStatusInputSchema,
  getApplicationLogsInputSchema, getFinOpsRecommendationInputSchema, inputSchemas,
  applicationSchema, listApplicationsDataSchema, getDeploymentStatusDataSchema,
  getApplicationLogsDataSchema, getFinOpsRecommendationDataSchema, dataSchemas,
  sourceStatusSchema, toolIssueSchema, responseSchemas,
  chatTurnRequestSchema, chatEventSchema, getInputJsonSchema, getOutputJsonSchema,
  diagnosticAnswerSchema, citesOnlyCalledSources, gcaCapabilities, gcpCloudAssistToolName,
  gcpCloudAssistInputSchema, gcpCloudAssistResponseSchema, chatToolNames,
};
