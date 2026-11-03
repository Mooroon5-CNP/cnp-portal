'use strict';

const { z } = require('zod');
const { toolNames } = require('../../../../packages/contracts/src');

const contextEnvironmentSchema = z.enum(['development', 'staging', 'production']);
const roleSchema = z.enum(['manager', 'devops', 'dev']);
const openPageSchema = z.enum([
  'applications_list', 'application_overview', 'deployment', 'logs', 'finops', 'unknown',
]);
const knownContextSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  actor: z.strictObject({
    userId: z.string().min(1).max(200), roles: z.array(roleSchema).min(1), authenticated: z.literal(true),
  }),
  navigation: z.strictObject({ openPage: openPageSchema, selectedTab: z.string().min(1).max(100).optional() }),
  target: z.strictObject({
    applicationId: z.string().min(1).max(200).optional(), environment: contextEnvironmentSchema.optional(),
  }),
  view: z.strictObject({
    timeRange: z.strictObject({ from: z.iso.datetime(), to: z.iso.datetime() }).optional(),
    filters: z.strictObject({
      logLevel: z.array(z.enum(['debug', 'info', 'warning', 'error'])).max(4).optional(),
      deploymentStatus: z.array(z.string().min(1).max(80)).max(20).optional(),
      search: z.string().max(200).optional(),
    }).optional(),
  }),
  permissions: z.strictObject({ allowedTools: z.array(z.enum(toolNames)) }),
  conversation: z.strictObject({
    confirmedApplicationId: z.string().min(1).max(200).optional(),
    confirmedEnvironment: contextEnvironmentSchema.optional(),
    pendingClarificationId: z.string().uuid().optional(),
  }),
  locale: z.strictObject({ language: z.enum(['fr', 'en']), timezone: z.string().min(1).max(100) }),
});
const contextCandidateSchema = z.strictObject({
  applicationId: z.string().min(1).max(200).optional(), environment: z.string().min(1).max(40).optional(),
});
const portalContextSchema = contextCandidateSchema.extend({
  openPage: openPageSchema.optional(), selectedTab: z.string().min(1).max(100).optional(),
  timeRange: z.strictObject({ from: z.string().max(100), to: z.string().max(100) }).optional(),
  filters: z.strictObject({
    logLevel: z.array(z.string().max(40)).max(10).optional(),
    deploymentStatus: z.array(z.string().max(80)).max(20).optional(),
    search: z.string().max(200).optional(),
  }).optional(),
  language: z.string().max(20).optional(), timezone: z.string().max(100).optional(),
});
const serverActorSchema = z.strictObject({
  userId: z.string().min(1).max(200), roles: z.array(roleSchema).min(1), authenticated: z.literal(true),
});

module.exports = {
  contextCandidateSchema, contextEnvironmentSchema, knownContextSchema,
  openPageSchema, portalContextSchema, serverActorSchema,
};
