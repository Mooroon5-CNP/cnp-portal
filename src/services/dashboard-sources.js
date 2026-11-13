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
module.exports = { readDashboardSources };
