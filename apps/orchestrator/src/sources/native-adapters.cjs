'use strict';

const yaml = require('js-yaml');
const { config } = require('../../../../src/config/env');
const github = require('../../../../src/services/github');
const argo = require('../../../../src/clients/argocd');
const datadog = require('../../../../src/clients/datadog');
const k8s = require('@kubernetes/client-node');

function createNativeAdapters({ SourceError, githubClient = github, argoClient = argo, datadogClient = datadog, settings = config } = {}) {
  const fail = (code, source) => { throw new SourceError(code, source); };
  const [owner, repo] = (settings.github.configRepoName || '').split('/');
  let cachedRegistry, cachedAt = 0;
  async function registry() {
    if (cachedRegistry && Date.now() - cachedAt < 30000) return cachedRegistry;
    if (!owner || !repo || !settings.github.configRepoToken) return fail('SOURCE_NOT_CONFIGURED', 'platform');
    try {
      const file = await githubClient.getFileWithSha(owner, repo, 'apps/registry.yaml', settings.github.configRepoToken);
      const records = yaml.load(file.content)?.apps;
      if (!Array.isArray(records)) return fail('SOURCE_RESPONSE_INVALID', 'platform');
      cachedRegistry = records.map((item) => {
        if (!/^[a-z0-9][a-z0-9-]{0,199}$/i.test(item.app_name)) return fail('SOURCE_RESPONSE_INVALID', 'platform');
        return { applicationId: item.app_name, name: item.app_name, team: item.team_owner || 'unknown',
          repositoryUrl: item.repo_url || '', environments: (item.environments || []).filter((env) => ['dev', 'prod'].includes(env))
            .map((name) => ({ name, enabled: true })) };
      });
      cachedAt = Date.now();
      return cachedRegistry;
    } catch (error) { if (error instanceof SourceError) throw error; return fail('SOURCE_UNAVAILABLE', 'platform'); }
  }
  async function get(id) { return (await registry()).find((item) => item.applicationId === id) || null; }
  async function document(path, source = 'git') {
    try {
      return yaml.load((await githubClient.getFileWithSha(owner, repo, path, settings.github.configRepoToken)).content);
    } catch (error) {
      if (error.response?.status === 404) return null;
      return fail('SOURCE_UNAVAILABLE', source);
    }
  }
  async function resolveDeployment(id, env) {
    if (!await get(id)) return fail('APPLICATION_NOT_FOUND', 'git');
    // A shared Cloud Run claim is the dev resource. Never mislabel it as a prod deployment.
    const claim = await document(`apps/${id}/crossplane/${env}/cloudrun-claim.yaml`)
      || (env === 'dev' ? await document(`apps/${id}/crossplane/cloudrun-claim.yaml`) : null);
    if (claim) return { platform: 'cloud_run', manifest: claim,
      image: claim.spec?.forProvider?.template?.containers?.[0]?.image || null };
    const overlay = await document(`apps/${id}/overlays/${env}/kustomization.yaml`);
    if (!overlay) return fail('ENVIRONMENT_NOT_FOUND', 'git');
    const deployment = await document(`apps/${id}/overlays/${env}/deployment.yaml`)
      || await document(`apps/${id}/base/deployment.yaml`);
    if (!deployment) return fail('SOURCE_RESPONSE_INVALID', 'git');
    const original = deployment.spec?.template?.spec?.containers?.[0]?.image;
    const imageName = original?.split('@')[0].replace(/:[^/:]+$/, '');
    const override = overlay.images?.find((item) => item.name === imageName);
    const suffix = original?.slice(imageName?.length || 0) || '';
    const image = override ? `${override.newName || imageName}${override.digest ? '@' + override.digest : override.newTag ? ':' + override.newTag : suffix}` : original;
    return { platform: 'gke', manifest: deployment, namespace: overlay.namespace || deployment.metadata?.namespace, image: image || null };
  }
  const versionOf = (image) => image && !image.includes('@') && /:[^/]+$/.test(image) ? image.slice(image.lastIndexOf(':') + 1) : null;
  const digestOf = (image) => image?.match(/@(sha256:[a-f0-9]{64})$/i)?.[1] || null;
  async function observed(id, env) {
    const explicit = JSON.parse(process.env.MCP_ARGO_APPLICATIONS || '{}')[`${id}/${env}`];
    const application = env === 'dev' ? await document(`apps/${id}/crossplane/application.yaml`, 'argo') : null;
    const name = explicit || application?.metadata?.name || `${id}-${env}`;
    try {
      const raw = await argoClient.getApplicationDetails(name);
      const images = raw.status?.summary?.images || [];
      const syncStatus = ['Synced', 'OutOfSync'].includes(raw.status?.sync?.status) ? raw.status.sync.status : 'Unknown';
      const healthStatus = ['Healthy', 'Progressing', 'Degraded'].includes(raw.status?.health?.status) ? raw.status.health.status : 'Unknown';
      return { version: versionOf(images[0]), imageDigest: digestOf(images[0]), syncStatus, healthStatus,
        lastDeploymentAt: raw.status?.operationState?.finishedAt || null };
    } catch { return fail('SOURCE_UNAVAILABLE', 'argo'); }
  }
  async function imageDigest(id, env) {
    const deployment = await resolveDeployment(id, env);
    if (deployment.platform === 'cloud_run') return fail('SOURCE_NOT_CONFIGURED', 'kubernetes');
    if (!settings.kubernetes.apiUrl || !settings.kubernetes.token || !settings.kubernetes.caCert) return fail('SOURCE_NOT_CONFIGURED', 'kubernetes');
    const kc = new k8s.KubeConfig();
    kc.loadFromOptions({ clusters: [{ name: 'cnp', server: settings.kubernetes.apiUrl, caData: settings.kubernetes.caCert }],
      users: [{ name: 'cnp', token: settings.kubernetes.token }], contexts: [{ name: 'cnp', cluster: 'cnp', user: 'cnp' }], currentContext: 'cnp' });
    const namespace = deployment.namespace || `${id}-${env}`;
    const selector = deployment.manifest.spec?.selector?.matchLabels;
    if (!selector || !Object.keys(selector).length) return fail('SOURCE_RESPONSE_INVALID', 'kubernetes');
    try {
      const response = await kc.makeApiClient(k8s.CoreV1Api).listNamespacedPod(namespace, undefined, undefined, undefined,
        undefined, Object.entries(selector).map(([key, value]) => `${key}=${value}`).join(','));
      const digests = [...new Set(response.body.items.flatMap((pod) => pod.status?.containerStatuses || [])
        .map((container) => container.imageID?.match(/(sha256:[a-f0-9]{64})$/i)?.[1]).filter(Boolean))];
      return digests.length === 1 ? digests[0] : null;
    } catch { return fail('SOURCE_UNAVAILABLE', 'kubernetes'); }
  }
  return {
    platform: { mode: 'real', get,
      list: async ({ query, environment, limit = 20, cursor }) => {
        const offset = cursor === undefined ? 0 : Number(cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) return fail('INVALID_INPUT', 'platform');
        const records = (await registry()).filter((item) => (!query || item.name.toLowerCase().includes(query.toLowerCase()))
          && (!environment || item.environments.some((entry) => entry.name === environment && entry.enabled)));
        const applications = records.slice(offset, offset + limit);
        return { applications, nextCursor: offset + limit < records.length ? String(offset + limit) : null };
      },
      workload: async (id, env) => {
        const deployment = await resolveDeployment(id, env);
        if (deployment.platform === 'cloud_run') {
          const volumes = deployment.manifest.spec?.forProvider?.template?.volumes || [];
          return { platform: 'cloud_run', stateless: volumes.length === 0, http: true, requiresKubernetes: false };
        }
        const annotations = deployment.manifest.metadata?.annotations || {};
        const keys = ['cnp.io/stateless', 'cnp.io/workload-http', 'cnp.io/requires-kubernetes'];
        if (!keys.every((key) => ['true', 'false'].includes(annotations[key]))) return null;
        return { platform: 'gke', stateless: annotations[keys[0]] === 'true',
          http: annotations[keys[1]] === 'true', requiresKubernetes: annotations[keys[2]] === 'true' };
      } },
    git: { mode: 'real', desired: async (id, env) => {
      const { image } = await resolveDeployment(id, env);
      const version = versionOf(image);
      return { version, imageDigest: digestOf(image), sourceRevision: /^[a-f0-9]{40}$/i.test(version || '') ? version : null };
    } },
    argo: { mode: 'real', observed },
    kubernetes: { mode: 'real', imageDigest },
    datadog: { mode: 'real', logs: async (input) => {
      if (!settings.datadog.apiKey || !settings.datadog.appKey) return fail('OBSERVABILITY_NOT_CONFIGURED', 'datadog');
      try { return await datadogClient.searchMcpLogs(input); } catch { return fail('SOURCE_UNAVAILABLE', 'datadog'); }
    }, metrics: async (id, env, days) => {
      if (!settings.datadog.apiKey || !settings.datadog.appKey || !process.env.MCP_CPU_PERCENT_METRIC || !process.env.MCP_MEMORY_PERCENT_METRIC)
        return fail('OBSERVABILITY_NOT_CONFIGURED', 'datadog');
      try { return await datadogClient.queryMcpMetrics(id, env, days); } catch { return fail('SOURCE_UNAVAILABLE', 'datadog'); }
    } },
  };
}

module.exports = { createNativeAdapters };
