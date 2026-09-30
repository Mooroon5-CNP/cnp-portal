'use strict';

const { toolNames } = require('../../../../packages/contracts/src');
const {
  contextCandidateSchema, knownContextSchema, portalContextSchema, serverActorSchema,
} = require('./known-context.schema');

const MAX_LOG_RANGE_MS = 24 * 60 * 60 * 1000;
const ENVIRONMENT_ALIASES = Object.freeze({
  dev: 'development', development: 'development', stage: 'staging', staging: 'staging',
  prod: 'production', production: 'production',
});

class AmbiguousContextError extends Error {
  constructor(candidates) {
    super('Several catalog applications match the requested context');
    this.name = 'AmbiguousContextError';
    this.candidates = candidates;
  }
}

function normalize(value) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function normalizeEnvironment(value) {
  return value ? ENVIRONMENT_ALIASES[normalize(value)] : undefined;
}

function containsLiteral(text, value) {
  const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(normalize(text));
}

function resolveExact(candidate, applications) {
  if (!candidate) return [];
  const normalized = normalize(candidate);
  return applications.filter((application) => normalize(application.applicationId) === normalized
    || normalize(application.name) === normalized);
}

function resolveTextCandidates(userRequest, applications) {
  if (!userRequest) return [];
  const exactMentions = applications.filter((application) => containsLiteral(userRequest, application.applicationId)
    || containsLiteral(userRequest, application.name));
  if (exactMentions.length) return exactMentions;
  const slugs = normalize(userRequest).match(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g) || [];
  return applications.filter((application) => slugs.some((slug) => {
    const id = normalize(application.applicationId);
    const name = normalize(application.name);
    return id.includes(slug) || slug.includes(id) || name.includes(slug);
  }));
}

function explicitEnvironment(userRequest) {
  if (!userRequest) return { supplied: false };
  const match = userRequest.match(/\b(dev|development|stage|staging|prod|production)\b/i);
  if (match) return { supplied: true, value: normalizeEnvironment(match[1]) };
  const unsupported = userRequest.match(/\b(qa|test|testing|preprod|pre-production)\b/i);
  return unsupported ? { supplied: true, value: undefined } : { supplied: false };
}

function pickCandidate(input, field) {
  for (const source of [input.portalContext, input.pageContext, input.confirmedConversationContext]) {
    if (source && Object.prototype.hasOwnProperty.call(source, field)) {
      return { supplied: true, value: source[field] };
    }
  }
  return { supplied: false };
}

function enabledFor(application, environment) {
  return application.environments.some((item) => normalizeEnvironment(item.name) === environment && item.enabled === true);
}

function validTimezone(value) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return value;
  } catch (_) {
    return 'Europe/Paris';
  }
}

function boundedTimeRange(candidate) {
  if (!candidate) return undefined;
  const from = Date.parse(candidate.from);
  const to = Date.parse(candidate.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return undefined;
  return { from: new Date(Math.max(from, to - MAX_LOG_RANGE_MS)).toISOString(), to: new Date(to).toISOString() };
}

function validatedFilters(filters) {
  if (!filters) return undefined;
  const allowedLevels = ['debug', 'info', 'warning', 'error'];
  const value = {
    ...(filters.logLevel
      ? { logLevel: [...new Set(filters.logLevel.map(normalize).filter((level) => allowedLevels.includes(level)))] }
      : {}),
    ...(filters.deploymentStatus ? { deploymentStatus: [...new Set(filters.deploymentStatus)] } : {}),
    ...(filters.search !== undefined
      && /^[\p{L}\p{N}\s._-]*$/u.test(filters.search)
      && !/\b(?:AND|OR|NOT)\b/.test(filters.search)
      ? { search: filters.search } : {}),
  };
  if (value.logLevel && !value.logLevel.length) delete value.logLevel;
  return Object.keys(value).length ? value : undefined;
}

function createKnownContextBuilder(catalog) {
  return async function buildKnownContext(rawInput = {}) {
    const input = {
      ...rawInput,
      actor: serverActorSchema.parse(rawInput.actor),
      portalContext: rawInput.portalContext ? portalContextSchema.parse(rawInput.portalContext) : undefined,
      pageContext: rawInput.pageContext ? portalContextSchema.parse(rawInput.pageContext) : undefined,
      confirmedConversationContext: rawInput.confirmedConversationContext
        ? contextCandidateSchema.parse(rawInput.confirmedConversationContext) : undefined,
    };
    const applications = await catalog.listApplications();
    const selectedApplication = pickCandidate(input, 'applicationId');
    const textApplications = resolveTextCandidates(input.userRequest, applications);
    if (textApplications.length > 1) {
      throw new AmbiguousContextError(textApplications.map((item) => item.applicationId));
    }
    let application;
    if (textApplications.length === 1) application = textApplications[0];
    else if (selectedApplication.supplied) {
      const matches = resolveExact(selectedApplication.value, applications);
      if (matches.length > 1) throw new AmbiguousContextError(matches.map((item) => item.applicationId));
      application = matches[0];
    }

    const selectedEnvironment = pickCandidate(input, 'environment');
    const textEnvironment = explicitEnvironment(input.userRequest);
    const environmentCandidate = textEnvironment.supplied ? textEnvironment.value
      : normalizeEnvironment(selectedEnvironment.value);
    const environment = environmentCandidate
      && (!application || enabledFor(application, environmentCandidate)) ? environmentCandidate : undefined;
    const confirmedApplication = resolveExact(
      input.confirmedConversationContext && input.confirmedConversationContext.applicationId, applications,
    )[0];
    const confirmedEnvironment = normalizeEnvironment(
      input.confirmedConversationContext && input.confirmedConversationContext.environment,
    );
    const ui = input.portalContext || input.pageContext || {};
    const allowedTools = (rawInput.allowedTools || toolNames).filter((tool) => toolNames.includes(tool));
    const timeRange = boundedTimeRange(ui.timeRange);
    const filters = validatedFilters(ui.filters);

    return knownContextSchema.parse({
      schemaVersion: '1.0',
      actor: input.actor,
      navigation: { openPage: ui.openPage || 'unknown', ...(ui.selectedTab ? { selectedTab: ui.selectedTab } : {}) },
      target: {
        ...(application ? { applicationId: application.applicationId } : {}),
        ...(environment ? { environment } : {}),
      },
      view: { ...(timeRange ? { timeRange } : {}), ...(filters ? { filters } : {}) },
      permissions: { allowedTools },
      conversation: {
        ...(confirmedApplication ? { confirmedApplicationId: confirmedApplication.applicationId } : {}),
        ...(confirmedEnvironment && (!confirmedApplication || enabledFor(confirmedApplication, confirmedEnvironment))
          ? { confirmedEnvironment } : {}),
        ...(rawInput.pendingClarificationId ? { pendingClarificationId: rawInput.pendingClarificationId } : {}),
      },
      locale: {
        language: ui.language === 'en' ? 'en' : 'fr',
        timezone: validTimezone(ui.timezone || 'Europe/Paris'),
      },
    });
  };
}

module.exports = {
  AmbiguousContextError, boundedTimeRange, createKnownContextBuilder,
  explicitEnvironment, normalizeEnvironment, resolveTextCandidates,
};
