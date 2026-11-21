'use strict';

// Suivi lisible d'une suppression, sur le modèle de la mise en service du secours (failover-provisioning.progress) : étape en
// cours, temps écoulé et estimé (étape et parcours), « plus long que d'habitude » au-delà du double. Lecture seule.
// Avant le 21/11/2026, la page n'affichait qu'un message générique pendant toute la suppression (plus de 35 min avec secours).
const { duration } = require('./environment-failover');

// Suppression complète d'une app avec secours (failover-teardown). Mesurée le 21/11/2026 sur recette-aws-2111 : libération
// ~5 min, destruction chez GCP et AWS ~31 min (les sondes Route 53 en dernier), nettoyage ~1 min.
const TEARDOWN = {
  release: ['Autorisation de suppression des bases et du secours', 60],
  'teardown-released': ['Prise en compte par Crossplane', 300],
  remove: ['Retrait des ressources du config-repo', 60],
  'teardown-gone': ['Destruction des ressources chez GCP et AWS', 1800],
  'teardown-cleanup': ['Suppression des secrets et de l’état de la surveillance', 60],
  forget: ['Désinscription, variables et identités de l’application', 120],
};
// Suppression d'un environnement sans secours (environment-deletion). Ordres de grandeur, pas encore mesurés : la disparition
// d'une base Cloud SQL prend plusieurs minutes.
const ENVIRONMENT = {
  inventory: ['Inventaire des ressources', 30], release: ['Autorisation de suppression des données', 60],
  release_wait: ['Prise en compte par Crossplane', 120], remove: ['Retrait des ressources du config-repo', 60],
  verify: ['Disparition des ressources chez le fournisseur', 600], variables: ['Suppression des variables et identités', 60],
  repository: ['Désinscription de l’application', 60],
};

function timing(labels, names, index, row, now) {
  const [label, estimate] = labels[names[index]] || [names[index], 120];
  const stepStart = Date.parse(row.step_started_at || row.updated_at || row.started_at);
  const elapsed = Math.max(0, Math.round((now - stepStart) / 1000));
  const totalElapsed = Math.max(0, Math.round((now - Date.parse(row.started_at)) / 1000));
  const remaining = Math.max(0, estimate - elapsed) + names.slice(index + 1).reduce((sum, name) => sum + (labels[name]?.[1] || 120), 0);
  return { label, step: index, total: names.length, elapsed, estimate, totalElapsed, totalEstimate: totalElapsed + remaining,
    slow: elapsed > 2 * estimate, state: row.state, detail: row.message || null };
}

function progress(dep, now = Date.now()) {
  const teardown = require('./failover-teardown');
  const row = teardown.get(dep.appName);
  if (row && row.deployment_id === dep.id && row.state !== 'completed') {
    const names = teardown.STEPS.map(([, name]) => name);
    return timing(TEARDOWN, names, Math.min(row.step, names.length - 1), row, now);
  }
  const deletion = require('./environment-deletion');
  const current = deletion.get(dep.id);
  if (!current || current.state === 'completed') return null;
  const index = Math.max(0, deletion.STEPS.indexOf(current.step));
  return timing(ENVIRONMENT, deletion.STEPS, index, current, now);
}

// Phrase affichée : « Suppression (étape 4/6) : Destruction … (étape 12 min / ~30 min, parcours 18 min / ~41 min). »
function message(dep, now = Date.now()) {
  const value = progress(dep, now);
  if (!value) return null;
  const times = `étape ${duration(value.elapsed)} / ~${duration(value.estimate)}, parcours ${duration(value.totalElapsed)} / ~${duration(value.totalEstimate)}`;
  const blocked = value.state === 'blocked' || value.state === 'failed';
  const slow = value.slow && !blocked ? ' Plus long que d’habitude : rien n’est bloqué tant qu’aucune erreur n’est affichée.' : '';
  return `Suppression (étape ${value.step + 1}/${value.total}) : ${value.label} (${times}).${value.detail ? ` ${value.detail}` : ''}${slow}`;
}

module.exports = { progress, message, TEARDOWN, ENVIRONMENT };
