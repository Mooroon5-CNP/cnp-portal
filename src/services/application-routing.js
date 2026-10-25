'use strict';

const yaml = require('js-yaml');
const axios = require('axios');
const { config } = require('../config/env');
const addresses = require('./application-address');
const kubernetes = require('../clients/kubernetes');
const ROUTING_PATH = 'platform/application-routing/urlmap.yaml';
const MAP_NAME = 'cnp-application-routing';
const apiVersion = 'compute.gcp.upbound.io/v1beta1';

function names(dep) {
  const service = `${dep.appName}-${dep.environment}`;
  return { service, neg: `cnp-${service}-neg`, backend: `cnp-${service}-backend`, matcher: `cnp-${service}` };
}
function backendUrl(dep) {
  return `https://www.googleapis.com/compute/v1/projects/${config.gcp.project}/global/backendServices/${names(dep).backend}`;
}
function network(dep) {
  const n = names(dep);
  const resource = (kind, name, wave, forProvider) => ({ apiVersion, kind,
    metadata: { name, annotations: { 'argocd.argoproj.io/sync-wave': String(wave) }, labels: { 'cnp.io/application': dep.appName, 'cnp.io/environment': dep.environment } },
    spec: { forProvider, providerConfigRef: { name: 'default' } } });
  return [resource('RegionNetworkEndpointGroup', n.neg, 4, {
    project: config.gcp.project, region: config.gcp.region, networkEndpointType: 'SERVERLESS', cloudRun: [{ service: n.service }],
  }), resource('BackendService', n.backend, 5, {
    project: config.gcp.project, protocol: 'HTTP', loadBalancingScheme: 'EXTERNAL_MANAGED', timeoutSec: 30,
    backend: [{ group: `https://www.googleapis.com/compute/v1/projects/${config.gcp.project}/regions/${config.gcp.region}/networkEndpointGroups/${n.neg}` }],
  })].map(doc => yaml.dump(doc)).join('---\n');
}
function updateMap(document, dep, remove = false) {
  if (document?.kind !== 'URLMap' || document.metadata?.name !== MAP_NAME
    || document.metadata.annotations?.['crossplane.io/external-name'] !== 'cnp-apps-urlmap'
    || document.spec?.forProvider?.project !== config.gcp.project || !document.spec.forProvider.defaultService) {
    throw new Error('Shared application URL map baseline missing or incompatible; operator bootstrap required.');
  }
  const doc = JSON.parse(JSON.stringify(document));
  const n = names(dep), host = addresses.hostname(dep);
  const fp = doc.spec.forProvider;
  const owner = `cnp.io/route-${n.service}`;
  const registeredHost = doc.metadata.annotations[owner];
  const conflict = (fp.hostRule || []).find(rule => rule.hosts?.includes(host) && (rule.pathMatcher !== n.matcher || registeredHost !== host));
  if (conflict) throw new Error(`Hostname ${host} already belongs to another route.`);
  if (remove && !registeredHost) return doc;
  if (!remove && !registeredHost && (fp.pathMatcher || []).some(rule => rule.name === n.matcher)) throw new Error('Existing path matcher is not owned by this deployment.');
  fp.hostRule = (fp.hostRule || []).filter(rule => !(rule.pathMatcher === n.matcher && registeredHost && rule.hosts?.length === 1 && rule.hosts[0] === registeredHost));
  fp.pathMatcher = (fp.pathMatcher || []).filter(rule => !(registeredHost && rule.name === n.matcher));
  if (!remove) {
    fp.hostRule.push({ hosts: [host], pathMatcher: n.matcher });
    fp.pathMatcher.push({ name: n.matcher, defaultService: backendUrl(dep) });
    doc.metadata.annotations[owner] = host;
  } else delete doc.metadata.annotations[owner];
  fp.hostRule.sort((a, b) => a.pathMatcher.localeCompare(b.pathMatcher));
  fp.pathMatcher.sort((a, b) => a.name.localeCompare(b.name));
  return doc;
}
async function read(api, repo, path, ref) {
  try {
    const { data } = await api.request('GET /repos/{owner}/{repo}/contents/{path}', { ...repo, path, ref });
    return yaml.load(Buffer.from(data.content, 'base64').toString());
  } catch (err) { if (err.status === 404) return null; throw err; }
}
async function sync(dep, { api, repo, commitFiles, beforePublish }, remove = false) {
  await commitFiles(api, repo, async head => {
    const baseline = await read(api, repo, ROUTING_PATH, head);
    const next = updateMap(baseline, dep, remove);
    const files = { [ROUTING_PATH]: yaml.dump(next) };
    if (!remove) {
      const path = `apps/${dep.appName}/crossplane/${dep.environment}`;
      const kustomization = await read(api, repo, `${path}/kustomization.yaml`, head);
      if (!kustomization) throw new Error('Published environment manifest missing.');
      kustomization.resources = [...new Set([...(kustomization.resources || []), 'application-network.yaml'])];
      files[`${path}/application-network.yaml`] = network(dep);
      files[`${path}/kustomization.yaml`] = yaml.dump(kustomization);
    }
    return files;
  }, `route(${dep.appName}): ${remove ? 'detach' : 'publish'} ${dep.environment}`, 'main', beforePublish);
}
function managedReady(body) {
  return ['Ready', 'Synced'].every(type => body?.status?.conditions?.some(item => item.type === type && item.status === 'True'));
}
async function status(dep, remove = false) {
  const n = names(dep);
  const map = await kubernetes.getComputeResource('urlmaps', MAP_NAME);
  const observed = map?.status?.atProvider;
  if (!managedReady(map) || !observed) return false;
  const host = addresses.hostname(dep);
  const hostRule = observed.hostRule?.find(rule => rule.hosts?.includes(host));
  const matcher = observed.pathMatcher?.find(rule => rule.name === n.matcher);
  if (remove) return !hostRule && !matcher;
  if (hostRule?.pathMatcher !== n.matcher || matcher?.defaultService !== backendUrl(dep)) return false;
  const [neg, backend] = await Promise.all([
    kubernetes.getComputeResource('regionnetworkendpointgroups', n.neg), kubernetes.getComputeResource('backendservices', n.backend),
  ]);
  if (!managedReady(neg) || !managedReady(backend) || neg.status?.atProvider?.cloudRun?.[0]?.service !== n.service) return false;
  const expected = `https://www.googleapis.com/compute/v1/projects/${config.gcp.project}/regions/${config.gcp.region}/networkEndpointGroups/${n.neg}`;
  if (!backend.status?.atProvider?.backend?.some(item => item.group === expected)) return false;
  try {
    const response = await axios.get(addresses.url(dep), { timeout: 10000, maxRedirects: 0, validateStatus: code => code >= 200 && code < 400 });
    return response.status >= 200 && response.status < 400;
  } catch (_) { return false; }
}
module.exports = { names, network, updateMap, sync, status, managedReady, ROUTING_PATH, MAP_NAME };
