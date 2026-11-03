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
  if (typeof module === 'object' && module.exports) module.exports = { describeResult };
  else root.CnpMcpResults = { describeResult };
})(typeof window === 'undefined' ? globalThis : window);
