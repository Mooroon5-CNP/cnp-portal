'use strict';

const k8s = require('@kubernetes/client-node');
const { config } = require('../config/env');

let _kc = null;

function getKubeConfig() {
  if (_kc) return _kc;

  if (!config.kubernetes.apiUrl || !config.kubernetes.token || !config.kubernetes.caCert) {
    throw new Error('Kubernetes credentials not configured (KUBE_API_URL, KUBE_TOKEN, KUBE_CA_CERT)');
  }

  _kc = new k8s.KubeConfig();
  _kc.loadFromOptions({
    clusters: [{
      name: 'gke',
      server: config.kubernetes.apiUrl,
      caData: config.kubernetes.caCert,
      skipTLSVerify: false,
    }],
    users: [{ name: 'sa', token: config.kubernetes.token }],
    contexts: [{ name: 'gke-ctx', user: 'sa', cluster: 'gke' }],
    currentContext: 'gke-ctx',
  });

  return _kc;
}

function handleError(err, context) {
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
    throw new Error(`Kubernetes API unreachable at ${config.kubernetes.apiUrl}: ${err.message}`);
  }
  if (err.response) {
    const status = err.response.statusCode || err.statusCode;
    if (status === 401) throw new Error('Kubernetes authentication failed. Check KUBE_TOKEN.');
    if (status === 403) throw new Error(`Kubernetes: insufficient permissions for ${context}. Check service account RBAC.`);
    if (status === 404) throw new Error(`Kubernetes: resource not found: ${context}`);
    throw new Error(`Kubernetes API error (${status}) on ${context}: ${err.response.body?.message || err.message}`);
  }
  throw new Error(`Kubernetes request failed (${context}): ${err.message}`);
}

async function getPods(namespace) {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const { body } = await coreApi.listNamespacedPod(namespace);
    return body.items.map(pod => ({
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      status: pod.status?.phase,
      conditions: pod.status?.conditions,
      restarts: pod.status?.containerStatuses?.[0]?.restartCount ?? 0,
      startTime: pod.status?.startTime,
      labels: pod.metadata.labels,
    }));
  } catch (err) {
    handleError(err, `getPods(${namespace})`);
  }
}

async function getAllPods() {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const { body } = await coreApi.listPodForAllNamespaces();
    return body.items.map(pod => ({
      name: pod.metadata.name,
      namespace: pod.metadata.namespace,
      status: pod.status?.phase,
      conditions: pod.status?.conditions,
      restarts: pod.status?.containerStatuses?.[0]?.restartCount ?? 0,
      startTime: pod.status?.startTime,
      labels: pod.metadata.labels,
    }));
  } catch (err) {
    handleError(err, 'getAllPods');
  }
}

async function deletePod(namespace, podName) {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await coreApi.deleteNamespacedPod(podName, namespace);
    return { deleted: podName, namespace };
  } catch (err) {
    handleError(err, `deletePod(${namespace}/${podName})`);
  }
}

async function scaleDeployment(namespace, deploymentName, replicas) {
  const kc = getKubeConfig();
  const appsApi = kc.makeApiClient(k8s.AppsV1Api);
  try {
    await appsApi.patchNamespacedDeployment(
      deploymentName,
      namespace,
      { spec: { replicas } },
      undefined, undefined, undefined, undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } },
    );
    return { deployment: deploymentName, namespace, replicas };
  } catch (err) {
    handleError(err, `scaleDeployment(${namespace}/${deploymentName} → ${replicas})`);
  }
}

async function getNamespaces() {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const { body } = await coreApi.listNamespace();
    const all = body.items.map(ns => ({
      name: ns.metadata.name,
      status: ns.status?.phase,
      labels: ns.metadata.labels,
      createdAt: ns.metadata.creationTimestamp,
    }));
    if (config.kubernetes.namespacePrefix) {
      return all.filter(ns => ns.name.startsWith(config.kubernetes.namespacePrefix));
    }
    return all;
  } catch (err) {
    handleError(err, 'getNamespaces');
  }
}

async function getEvents(namespace) {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const { body } = await coreApi.listNamespacedEvent(namespace);
    return body.items.map(ev => ({
      name: ev.metadata.name,
      namespace: ev.metadata.namespace,
      reason: ev.reason,
      message: ev.message,
      type: ev.type,
      count: ev.count,
      firstSeen: ev.firstTimestamp,
      lastSeen: ev.lastTimestamp,
      involvedObject: ev.involvedObject?.name,
    }));
  } catch (err) {
    handleError(err, `getEvents(${namespace})`);
  }
}

async function getAllEvents() {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const { body } = await coreApi.listEventForAllNamespaces();
    return body.items.map(ev => ({
      name: ev.metadata.name,
      namespace: ev.metadata.namespace,
      reason: ev.reason,
      message: ev.message,
      type: ev.type,
      count: ev.count,
      firstSeen: ev.firstTimestamp,
      lastSeen: ev.lastTimestamp,
      involvedObject: ev.involvedObject?.name,
    }));
  } catch (err) {
    handleError(err, 'getAllEvents');
  }
}

async function getAllResourceQuotas() {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    const { body } = await coreApi.listResourceQuotaForAllNamespaces();
    return body.items.map(q => ({
      name: q.metadata.name,
      namespace: q.metadata.namespace,
      hard: q.spec?.hard || {},
      used: q.status?.used || {},
    }));
  } catch (err) {
    handleError(err, 'getAllResourceQuotas');
  }
}

// List Crossplane CompositeResourceDefinitions (XRDs)
async function getCompositeResources() {
  const kc = getKubeConfig();
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  try {
    const { body } = await customApi.listClusterCustomObject(
      'apiextensions.crossplane.io',
      'v1',
      'compositeresourcedefinitions',
    );
    return (body.items || []).map(xrd => ({
      name: xrd.metadata.name,
      group: xrd.spec?.group,
      kind: xrd.spec?.names?.kind,
      claimKind: xrd.spec?.claimNames?.kind,
      established: xrd.status?.conditions?.find(c => c.type === 'Established')?.status === 'True',
    }));
  } catch (err) {
    handleError(err, 'getCompositeResources');
  }
}

async function checkConnectivity() {
  const kc = getKubeConfig();
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await coreApi.listNamespace();
  } catch (err) {
    handleError(err, 'checkConnectivity');
  }
}

// Apply or replace an ArgoCD ApplicationSet in the argocd namespace.
async function applyApplicationSet(manifest) {
  const kc = getKubeConfig();
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  const group = 'argoproj.io';
  const version = 'v1alpha1';
  const plural = 'applicationsets';
  const namespace = 'argocd';
  const name = manifest.metadata.name;

  try {
    // Try to update first; if 404, create instead.
    try {
      const { body: existing } = await customApi.getNamespacedCustomObject(group, version, namespace, plural, name);
      manifest.metadata.resourceVersion = existing.metadata.resourceVersion;
      await customApi.replaceNamespacedCustomObject(group, version, namespace, plural, name, manifest);
    } catch (e) {
      if (e.response && (e.response.statusCode === 404 || e.statusCode === 404)) {
        await customApi.createNamespacedCustomObject(group, version, namespace, plural, manifest);
      } else {
        throw e;
      }
    }
  } catch (err) {
    handleError(err, `applyApplicationSet(${name})`);
  }
}

// Delete an ArgoCD ApplicationSet from the argocd namespace (idempotent).
async function deleteApplicationSet(name) {
  const kc = getKubeConfig();
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  try {
    await customApi.deleteNamespacedCustomObject('argoproj.io', 'v1alpha1', 'argocd', 'applicationsets', name);
  } catch (err) {
    if (err.response && (err.response.statusCode === 404 || err.statusCode === 404)) return;
    handleError(err, `deleteApplicationSet(${name})`);
  }
}

// Apply or replace an ArgoCD Application in the argocd namespace.
async function applyArgocdApplication(manifest) {
  const kc = getKubeConfig();
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  const group = 'argoproj.io';
  const version = 'v1alpha1';
  const plural = 'applications';
  const namespace = 'argocd';
  const name = manifest.metadata.name;

  try {
    try {
      const { body: existing } = await customApi.getNamespacedCustomObject(group, version, namespace, plural, name);
      manifest.metadata.resourceVersion = existing.metadata.resourceVersion;
      await customApi.replaceNamespacedCustomObject(group, version, namespace, plural, name, manifest);
    } catch (e) {
      if (e.response && (e.response.statusCode === 404 || e.statusCode === 404)) {
        await customApi.createNamespacedCustomObject(group, version, namespace, plural, manifest);
      } else {
        throw e;
      }
    }
  } catch (err) {
    handleError(err, `applyArgocdApplication(${name})`);
  }
}

// Delete an ArgoCD Application from the argocd namespace (idempotent).
async function deleteArgocdApplication(name) {
  const kc = getKubeConfig();
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  try {
    await customApi.deleteNamespacedCustomObject('argoproj.io', 'v1alpha1', 'argocd', 'applications', name);
  } catch (err) {
    if (err.response && (err.response.statusCode === 404 || err.statusCode === 404)) return;
    handleError(err, `deleteArgocdApplication(${name})`);
  }
}

async function getV2ServiceUrl(appName) {
  const kc = getKubeConfig();
  const customApi = kc.makeApiClient(k8s.CustomObjectsApi);
  try {
    const { body } = await customApi.getNamespacedCustomObject(
      'cloudrun.gcp.upbound.io', 'v1beta2', 'crossplane-system', 'v2services', appName,
    );
    return body.status?.atProvider?.uri || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  getPods, getAllPods, deletePod, scaleDeployment,
  getNamespaces, getEvents, getAllEvents, getAllResourceQuotas,
  getCompositeResources, checkConnectivity,
  applyApplicationSet, deleteApplicationSet,
  applyArgocdApplication, deleteArgocdApplication,
  getV2ServiceUrl,
};
