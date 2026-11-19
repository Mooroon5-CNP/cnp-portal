'use strict';
/* eslint-env browser */

// Shared presentation of validated tool data. No HTML is produced from source strings.
(function(root) {
  const value = item => item === null || item === undefined ? 'Indisponible' : String(item);
  function describeResult(tool, data) {
    if (tool === 'list_applications') return {
      title: 'Applications accessibles', columns: ['Application', 'Équipe', 'Environnements'],
      rows: data.applications.map(app => [app.name, app.team, app.environments.filter(env => env.enabled).map(env => env.name).join(', ')]),
      notes: data.nextCursor ? ['Le catalogue contient d’autres résultats. Précisez la recherche pour les retrouver.'] : [],
    };
    if (tool === 'get_deployment_status') return {
      title: `Déploiement — ${data.applicationId} (${data.environment})`, columns: ['Indicateur', 'Valeur'],
      rows: [
        ['Version souhaitée', value(data.desiredState.version)], ['Version observée', value(data.observedState.version)],
        ['Digest souhaité', value(data.desiredState.imageDigest)], ['Digest observé', value(data.observedState.imageDigest)],
        ['Santé', data.observedState.healthStatus], ['Synchronisation', data.observedState.syncStatus],
        ['Dérive détectée', data.driftDetected === null ? 'Indéterminée' : data.driftDetected ? 'Oui' : 'Non'],
        ['Dernier déploiement', value(data.lastDeploymentAt)],
      ], notes: [],
    };
    if (tool === 'get_application_logs') return {
      title: 'Logs de l’application', columns: ['Date', 'Niveau', 'Message', 'Version'],
      rows: data.logs.map(log => [log.timestamp, log.level, log.message, value(log.version)]),
      notes: [
        ...(data.truncated || data.nextCursor ? ['Résultats limités : affinez la période ou la recherche.'] : []),
        ...(data.redactedFields ? [`${data.redactedFields} champ(s) sensible(s) masqué(s).`] : []),
      ],
    };
    if (tool === 'get_finops_recommendation') return {
      title: 'Analyse FinOps', columns: ['Indicateur', 'Valeur'],
      rows: [
        ['Recommandation', data.recommendation], ['Confiance', data.confidence],
        ...Object.entries({ 'CPU moyen (%)': data.utilization.averageCpuPercent, 'CPU maximal (%)': data.utilization.peakCpuPercent,
          'Mémoire moyenne (%)': data.utilization.averageMemoryPercent, 'Mémoire maximale (%)': data.utilization.peakMemoryPercent }).map(([label, item]) => [label, value(item)]),
        ['Coût mensuel', value(data.currentMonthlyCost)], ['Économies estimées', value(data.estimatedMonthlySavings)],
      ], notes: [...data.assumptions, ...data.risks, ...data.prerequisites, ...data.nextSteps],
    };
    throw new Error('UNKNOWN_MCP_TOOL');
  }
  const sourceNames = { gemini_cloud_assist: 'Gemini Cloud Assist', argo: 'Argo CD', git: 'Git/config', kubernetes: 'Kubernetes', datadog: 'Datadog', platform: 'Platform API' };
  const source = name => sourceNames[name] || name;
  const when = item => item ? ` — ${item}` : '';
  /** The mandatory 7 sections, in order; every line keeps its source. */
  function describeDiagnostic(answer) {
    const confidence = { high: 'Élevé', medium: 'Moyen', low: 'Faible' }[answer.confidence.level];
    return [
      { title: '1. Résumé', items: [answer.summary] },
      { title: '2. Observations', items: answer.observations.map(o => `[${source(o.source)}] ${o.fact}${o.resource ? ` (${o.resource})` : ''}${when(o.observedAt)}`) },
      { title: '3. Diagnostic / interprétation', items: answer.diagnosis.map(d => `${d.kind === 'fact' ? 'Fait' : 'Hypothèse'} : ${d.statement}`) },
      { title: '4. Éléments de preuve', items: answer.evidence.map(e => `[${source(e.source)}] ${value(e.resource)}${e.period ? ` — période ${e.period.from} → ${e.period.to} (UTC)` : ''}${when(e.observedAt)}${e.values ? ` : ${e.values}` : ''}`) },
      { title: '5. Recommandations (non exécutées)', items: answer.recommendations.map(r => `P${r.priority} — ${r.action}`) },
      { title: '6. Niveau de confiance', items: [`${confidence} : ${answer.confidence.justification}`] },
      { title: '7. Limites / données manquantes', items: answer.limitations },
    ].map(section => ({ ...section, items: section.items.length ? section.items : ['Aucun élément.'] }));
  }
  if (typeof module === 'object' && module.exports) module.exports = { describeResult, describeDiagnostic };
  else root.CnpMcpResults = { describeResult, describeDiagnostic };
})(typeof window === 'undefined' ? globalThis : window);
