'use strict';

// Read-only chat: there is no write tool at all, so this filter only shapes the answer. It refuses clear change
// requests, never questions that merely mention a deployment ("le deploy est ok ?", "qu'est-ce qui a changé ?").
// Unambiguous action verbs anywhere in the request:
const ACTION_ANYWHERE = /\b(delete|remove|restart|rollback|roll\s+back|scale|resize|migrate|destroy|shutdown|redeploy|supprim(?:er|ez|e)|redemarr(?:er|ez|e)|redimensionn(?:er|ez|e)|migrer|detrui(?:re|s|sez)|effac(?:er|ez)|arret(?:er|ez))\b/i;
// Words that are verbs only as an imperative/infinitive at the start of the request ("Deploy X", "Déploie X"):
const ACTION_AT_START = /^\s*(?:(?:peux|pourrais|veux)[\s-]+tu\s+|merci\s+de\s+|please\s+|can\s+you\s+)?(deploy|sync|update|create|change|promote|deployer|deploie|deployez|synchronis(?:er|e|ez)|mets?\s+a\s+jour|creer|cree|modifi(?:er|e|ez)|promouvoir|arrete)\b/i;

const CANDIDATES = [
  ['get_application_logs', /\b(log|logs|trace|traces|error|errors|erreurs?|exceptions?|journal|journaux|plant(?:e|ent|age)|crash(?:e|es)?|bug(?:s|ue)?|lent(?:e|es)?|lenteurs?|latence|timeouts?|5\d\d)\b/i],
  ['get_deployment_status', /\b(deploy(?:ment)?|deploiement|deployee?s?|status|statut|health|healthy|sante|etat|sync|synchronise(?:e|es)?|desynchronise(?:e|es)?|version|drift|derive|en\s+ligne|tourne|change|modifie|revision)\b/i],
  ['get_finops_recommendation', /\b(finops|cost|costs|saving|savings|resource|resources|cpu|memory|cout(?:s|e|ent)?|economies?|ressources?|memoire|prix|factur\w*|depenses?|budget)\b/i],
];
const LIST = /\b(app|apps|application|applications|catalog|catalogue|list|liste|lister)\b/i;

function classifyWithFallback(input) {
  const original = typeof input === 'string' ? input : input.userRequest;
  const message = original.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (ACTION_ANYWHERE.test(message) || ACTION_AT_START.test(message)) {
    return { kind: 'mutation', reason: 'The request implies a platform change.' };
  }
  const candidates = CANDIDATES.filter(([, pattern]) => pattern.test(message));
  if (candidates.length === 1) return { kind: 'tool', tool: candidates[0][0], fallback: true };
  // "app/application" is in almost every question: it only means the catalogue when nothing else matched.
  if (!candidates.length && LIST.test(message)) return { kind: 'tool', tool: 'list_applications', fallback: true };
  return { kind: 'clarification' };
}

module.exports = { classifyWithFallback };
