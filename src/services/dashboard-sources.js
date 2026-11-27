'use strict';

// Bound page latency independently of individual provider timeout behavior.
async function readDashboardSources(sources, timeoutMs = 3000) {
  const entries = await Promise.all(Object.entries(sources).map(async ([name, read]) => {
    let timer;
    try {
      const unavailable = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SOURCE_TIMEOUT')), timeoutMs);
      });
      const data = await Promise.race([Promise.resolve().then(read), unavailable]);
      if (!Array.isArray(data)) throw new Error('INVALID_SOURCE_RESPONSE');
      return [name, { available: true, data }];
    } catch (_) {
      return [name, { available: false, data: [] }];
    } finally { clearTimeout(timer); }
  }));
  return Object.fromEntries(entries);
}
// Les applications des équipes vivent dans les projets Argo CD team-cnp-* ; le reste (Crossplane, routage,
// ingress, certificats, portail) est la plateforme et ne se compte pas comme une application.
function splitArgoApps(apps) {
  const isApplication = app => String(app.project || '').startsWith('team-cnp-');
  return { applications: apps.filter(isApplication), platform: apps.filter(app => !isApplication(app)) };
}

module.exports = { readDashboardSources, splitArgoApps };
