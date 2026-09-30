'use strict';

const MUTATION_PATTERN = /\b(deploy|delete|remove|restart|rollback|sync|scale|resize|migrate|promote|create|update|change|modifier|supprimer|déployer|redémarrer|synchroniser|redimensionner|migrer|promouvoir|créer)\b/i;

function classifyWithFallback(input) {
  const message = typeof input === 'string' ? input : input.userRequest;
  if (MUTATION_PATTERN.test(message)) {
    return { kind: 'mutation', reason: 'The request implies a platform change.' };
  }

  const candidates = [
    ['get_application_logs', /\b(log|logs|trace|error|exception|journal|journaux)\b/i],
    ['get_deployment_status', /\b(deploy(?:ment)?|status|health|healthy|sync|version|drift|déploiement|état|santé)\b/i],
    ['get_finops_recommendation', /\b(finops|cost|saving|resource|cpu|memory|cloud run|gke|coût|économie|ressource|mémoire)\b/i],
    ['list_applications', /\b(app|apps|application|applications|catalog|catalogue|list|liste)\b/i],
  ].filter(([, pattern]) => pattern.test(message));

  if (candidates.length !== 1) {
    return { kind: 'clarification' };
  }
  return { kind: 'tool', tool: candidates[0][0], fallback: true };
}

module.exports = { classifyWithFallback };
