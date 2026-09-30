'use strict';

function buildToolArguments(tool, knownContext, now = new Date()) {
  const environmentMap = { development: 'dev', production: 'prod' };
  const environment = environmentMap[knownContext.target.environment];
  if (tool === 'list_applications') {
    return environment
      ? { environment, limit: 20 }
      : { limit: 20 };
  }

  const { applicationId } = knownContext.target;
  if (!applicationId || !environment) {
    return null;
  }

  if (tool === 'get_application_logs') {
    const timeRange = knownContext.view.timeRange || {
      from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      to: now.toISOString(),
    };
    const levelMap = { debug: 'DEBUG', info: 'INFO', warning: 'WARN', error: 'ERROR' };
    const filters = knownContext.view.filters || {};
    return {
      applicationId,
      environment,
      from: timeRange.from,
      to: timeRange.to,
      ...(filters.logLevel ? { levels: filters.logLevel.map((level) => levelMap[level]) } : {}),
      ...(filters.search ? { query: filters.search } : {}),
      limit: 50,
    };
  }
  if (tool === 'get_finops_recommendation') {
    return { applicationId, environment, observationWindowDays: 14 };
  }
  return { applicationId, environment };
}

module.exports = { buildToolArguments };
