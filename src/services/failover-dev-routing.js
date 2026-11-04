'use strict';

// La map partagée référence ce backend dev déjà committé. Sa restauration
// sélective ne synchronise ni Cloud Run dev ni son bucket ni les autres apps.
const k8s = require('@kubernetes/client-node');
const { config } = require('../config/env');
const github = require('../clients/github');
const argocd = require('../clients/argocd');
const sourcePath = 'apps/app4-pixelcam/crossplane/dev';
const resource = { group: 'compute.gcp.upbound.io', kind: 'BackendService', name: 'cnp-app4-pixelcam-dev-backend' };

async function repair(user) {
  if (!user || user.role !== 'manager' || !user.id) throw new Error('Validation manager requise.');
  const git = await github.getInstallationOctokit();
  const { data: head } = await git.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
    owner: 'Mooroon5-CNP', repo: 'config-repo', ref: 'heads/main',
  });
  const revision = head.object.sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Révision Git invalide.');
  const kc = new k8s.KubeConfig();
  kc.loadFromOptions({ clusters: [{ name: 'gke', server: config.kubernetes.apiUrl, caData: config.kubernetes.caCert, skipTLSVerify: false }],
    users: [{ name: 'sa', token: config.kubernetes.token }], contexts: [{ name: 'ctx', user: 'sa', cluster: 'gke' }], currentContext: 'ctx' });
  const api = kc.makeApiClient(k8s.CustomObjectsApi);
  const args = ['argoproj.io', 'v1alpha1', 'argocd', 'applications'];
  let existing;
  try { existing = (await api.getNamespacedCustomObject(...args, 'app4-pixelcam-dev')).body; }
  catch (err) { if ((err.response?.statusCode || err.statusCode) !== 404) throw err; }
  if (existing) {
    if (existing.metadata.deletionTimestamp || existing.spec.project !== 'team-cnp-dev'
      || existing.spec.source.path !== sourcePath || existing.spec.syncPolicy?.automated) {
      throw new Error('Application dev inattendue : réparation interrompue.');
    }
  } else {
    await api.createNamespacedCustomObject(...args, {
      apiVersion: 'argoproj.io/v1alpha1', kind: 'Application',
      metadata: { name: 'app4-pixelcam-dev', namespace: 'argocd' },
      spec: { project: 'team-cnp-dev',
        source: { repoURL: 'https://github.com/Mooroon5-CNP/config-repo.git', targetRevision: revision, path: sourcePath },
        destination: { server: 'https://kubernetes.default.svc', namespace: 'crossplane-system' },
        syncPolicy: { syncOptions: ['CreateNamespace=true'] } },
    });
  }
  await argocd.syncApplication('app4-pixelcam-dev', [resource]);
  return { application: 'app4-pixelcam-dev', revision, selective_sync: [resource], prune: false };
}
module.exports = { repair };
