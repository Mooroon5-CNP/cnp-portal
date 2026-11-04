'use strict';

// Réparation additive du propriétaire GitOps. Ne supprime aucune Application
// ni ressource cloud ; conserve les sélections Azure existantes de Maia.
const k8s = require('@kubernetes/client-node');
const { config } = require('../config/env');
function desired(existing) {
  const patch = require('./application-set-preservation').additivePatch(existing, ['apps/app4-pixelcam/crossplane/prod']);
  const ignores = [...(existing.spec.ignoreApplicationDifferences || [])];
  if (!ignores.some(rule => rule.name === 'app4-pixelcam-prod' && rule.jsonPointers?.includes('/spec/syncPolicy'))) {
    ignores.push({ name: 'app4-pixelcam-prod', jsonPointers: ['/spec/syncPolicy'] });
  }
  // L'Application réparée reste manuelle, sans changer le template d'Azure.
  patch.push({ op: 'add', path: '/spec/ignoreApplicationDifferences', value: ignores });
  return patch;
}
async function reconcile(user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({ clusters: [{ name: 'gke', server: config.kubernetes.apiUrl, caData: config.kubernetes.caCert, skipTLSVerify: false }],
    users: [{ name: 'sa', token: config.kubernetes.token }], contexts: [{ name: 'ctx', user: 'sa', cluster: 'gke' }], currentContext: 'ctx' });
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const args = ['argoproj.io', 'v1alpha1', 'argocd', 'applicationsets', 'crossplane-autodiscovery-prod'];
  const { body } = await api.getNamespacedCustomObject(...args);
  const patch = desired(body);
  await api.patchNamespacedCustomObject(...args, patch, undefined, undefined, undefined, { headers: { 'Content-Type': 'application/json-patch+json' } });
  return { reconciled: true, directories: patch[1].value, cloud_resources_deleted: false };
}
module.exports = { desired, reconcile };
