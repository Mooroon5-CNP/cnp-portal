'use strict';

const { diagnosticAnswerSchema, citesOnlyCalledSources } = require('../../../../packages/contracts/src');

const LEVELS = ['low', 'medium', 'high'];
const lowest = (...levels) => LEVELS[Math.min(...levels.map((level) => LEVELS.indexOf(level)))];
const available = (result, source) => Boolean(result && result.status !== 'error'
  && result.meta.sources.some((item) => item.source === source && item.status === 'available'));
const sourceLabel = { argo: 'Argo CD', git: 'Git/config', kubernetes: 'Kubernetes', datadog: 'Datadog', gemini_cloud_assist: 'Gemini Cloud Assist' };

/**
 * Deterministic 7-section answer for a cross-source diagnosis. Facts come only from tool results that were
 * actually returned; every item names its source; nothing is executed. `results` maps tool name to the
 * validated ToolResponse, or to `{ errorCode }` when the call failed.
 */
function buildTransverseAnswer({ target, logWindow, results }) {
  const observations = [], evidence = [], diagnosis = [], limitations = [], summary = [];
  const resource = `${target.applicationId}/${target.environment}`;
  const deployment = results.get_deployment_status, logs = results.get_application_logs, gca = results.gcp_cloud_assist;
  const failed = (result) => !result || result.errorCode || result.status === 'error';
  const failure = (result) => (result && (result.errorCode || (result.errors && result.errors[0] && result.errors[0].code))) || 'NOT_CALLED';
  let confidence = 'medium';

  if (!failed(deployment)) {
    const data = deployment.data;
    const observedSource = available(deployment, 'argo') ? 'argo' : undefined;
    if (observedSource) {
      observations.push({ source: 'argo', fact: `État observé : santé ${data.observedState.healthStatus}, synchronisation ${data.observedState.syncStatus}, version ${data.observedState.version || 'inconnue'}.`, resource, observedAt: data.lastDeploymentAt });
      evidence.push({ source: 'argo', resource, period: null, observedAt: data.lastDeploymentAt, values: `health=${data.observedState.healthStatus}; sync=${data.observedState.syncStatus}` });
      summary.push(`déploiement ${data.observedState.healthStatus}/${data.observedState.syncStatus}`);
    }
    if (available(deployment, 'git')) {
      observations.push({ source: 'git', fact: `Version souhaitée : ${data.desiredState.version || 'inconnue'} (révision ${data.desiredState.sourceRevision || 'inconnue'}).`, resource, observedAt: null });
    }
    if (available(deployment, 'kubernetes') && data.observedState.imageDigest) {
      evidence.push({ source: 'kubernetes', resource, period: null, observedAt: null, values: `imageDigest=${data.observedState.imageDigest}` });
    }
    if (data.driftDetected === true && observedSource) diagnosis.push({ kind: 'fact', statement: 'Une dérive entre l’état souhaité et l’état observé est détectée.' });
    if (deployment.status === 'partial') { limitations.push('Données de déploiement partielles.'); confidence = 'low'; }
  } else { limitations.push(`État du déploiement indisponible (${failure(deployment)}).`); confidence = 'low'; }

  let errorCount = 0;
  if (!failed(logs) && available(logs, 'datadog')) {
    const entries = logs.data.logs;
    errorCount = entries.filter((entry) => entry.level === 'ERROR').length;
    observations.push({ source: 'datadog', fact: `${entries.length} entrée(s) de log dont ${errorCount} erreur(s) sur la période.`, resource, observedAt: null });
    evidence.push({ source: 'datadog', resource, period: logWindow, observedAt: null, values: `logs=${entries.length}; errors=${errorCount}${logs.data.truncated ? '; tronqué' : ''}` });
    for (const entry of entries.filter((item) => item.level === 'ERROR').slice(0, 3)) {
      evidence.push({ source: 'datadog', resource: entry.service, period: null, observedAt: entry.timestamp, values: entry.message.slice(0, 2000) });
    }
    summary.push(`${errorCount} erreur(s) dans les logs`);
    if (logs.status === 'partial') { limitations.push('Logs partiels ou tronqués.'); confidence = 'low'; }
  } else { limitations.push(`Logs Datadog indisponibles (${failure(logs)}).`); confidence = 'low'; }

  if (!failed(deployment) && available(deployment, 'argo') && deployment.data.observedState.healthStatus === 'Healthy' && errorCount > 0) {
    limitations.push(`Sources divergentes : Argo CD indique Healthy alors que Datadog remonte ${errorCount} erreur(s).`);
  }

  let recommendations = [];
  if (!failed(gca)) {
    const answer = gca.data.answer;
    observations.push(...answer.observations);
    evidence.push(...answer.evidence);
    diagnosis.push(...answer.diagnosis);
    recommendations = answer.recommendations;
    limitations.push(...answer.limitations);
    confidence = lowest(confidence, answer.confidence.level);
    summary.push(`Gemini Cloud Assist : ${answer.summary}`);
  } else { limitations.push(`Analyse Gemini Cloud Assist indisponible (${failure(gca)}).`); confidence = 'low'; }

  for (const result of Object.values(results)) {
    if (result && result.warnings && result.warnings.some((warning) => warning.code === 'MOCK_DATA')) {
      limitations.push('Certaines sources renvoient des données synthétiques (mode mock) : ne pas les interpréter comme réelles.');
      confidence = 'low';
      break;
    }
  }
  if (!observations.length) { confidence = 'low'; limitations.push('Aucune donnée fiable n’a été obtenue : précisez l’application, l’environnement ou la période.'); }
  const consulted = [...new Set(observations.concat(evidence).map((item) => sourceLabel[item.source] || item.source))];
  const answer = diagnosticAnswerSchema.parse({
    summary: `${target.applicationId} (${target.environment}) : ${summary.length ? summary.join(' ; ') : 'aucune donnée disponible'}.`.slice(0, 2000),
    observations: observations.slice(0, 50), diagnosis: diagnosis.slice(0, 30), evidence: evidence.slice(0, 50),
    recommendations: recommendations.slice(0, 20),
    confidence: { level: confidence, justification: consulted.length ? `Sources consultées : ${consulted.join(', ')}.` : 'Aucune source n’a répondu.' },
    limitations: [...new Set(limitations)].slice(0, 30),
  });
  return answer;
}

/** Sources that answered, for the turn summary and the cited-source check. */
function collectSources(results) {
  const merged = new Map();
  for (const result of Object.values(results)) {
    for (const item of (result && result.meta ? result.meta.sources : [])) {
      if (!merged.has(item.source) || item.status === 'available') merged.set(item.source, { source: item.source, status: item.status });
    }
  }
  return [...merged.values()];
}

function assertCitedSources(answer, sources) {
  if (!citesOnlyCalledSources(answer, sources)) throw new Error('UNCALLED_SOURCE_CITED');
  return answer;
}

module.exports = { buildTransverseAnswer, collectSources, assertCitedSources };
