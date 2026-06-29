'use strict';

const client = require('../clients/kubernetes');

function computeAge(startTime) {
  if (!startTime) return '—';
  const ms = Date.now() - new Date(startTime).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function timeAgo(date) {
  if (!date) return '—';
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function podAppName(pod) {
  return pod.labels?.['app.kubernetes.io/name']
    || pod.labels?.['app']
    || pod.name.split('-').slice(0, -2).join('-')
    || pod.name;
}

async function listPods() {
  try {
    const pods = await client.getAllPods();
    return pods.map(pod => ({
      name:      pod.name,
      namespace: pod.namespace,
      app:       podAppName(pod),
      status:    pod.status || 'Unknown',
      restarts:  pod.restarts,
      age:       computeAge(pod.startTime),
    }));
  } catch (err) {
    console.error('[k8s] listPods error:', err.message);
    return [];
  }
}

async function deletePod(podName, namespace) {
  return client.deletePod(namespace, podName);
}

async function scaleDeployment(deploymentName, replicas, namespace) {
  if (replicas < 0 || replicas > 20) throw new Error('Invalid replica count (0-20)');
  return client.scaleDeployment(namespace, deploymentName, replicas);
}

// Convert a Kubernetes CPU string ("500m", "2", "1.5") to millicores (integer).
function parseCpuMillicores(val) {
  if (!val || val === '—') return null;
  if (String(val).endsWith('m')) return parseInt(val, 10);
  return Math.round(parseFloat(val) * 1000);
}

// Convert a Kubernetes memory string ("256Mi", "1Gi", "512Ki") to MiB (float).
function parseMemMiB(val) {
  if (!val || val === '—') return null;
  const s = String(val);
  if (s.endsWith('Ki')) return parseFloat(s) / 1024;
  if (s.endsWith('Mi')) return parseFloat(s);
  if (s.endsWith('Gi')) return parseFloat(s) * 1024;
  if (s.endsWith('Ti')) return parseFloat(s) * 1024 * 1024;
  if (s.endsWith('K'))  return parseFloat(s) / 1024;
  if (s.endsWith('M'))  return parseFloat(s);
  if (s.endsWith('G'))  return parseFloat(s) * 1024;
  return parseFloat(s) / (1024 * 1024); // raw bytes → MiB
}

function usagePercent(used, hard) {
  if (used === null || hard === null || hard === 0) return null;
  return Math.min(100, Math.round((used / hard) * 100));
}

function fmtMiB(mib) {
  if (mib === null) return '—';
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${Math.round(mib)} MiB`;
}

function fmtCpu(milliCores) {
  if (milliCores === null) return '—';
  if (milliCores >= 1000) return `${(milliCores / 1000).toFixed(2)}`;
  return `${milliCores}m`;
}

async function listQuotas() {
  try {
    const quotas = await client.getAllResourceQuotas();
    return quotas.map(q => {
      const hardCpuReq  = parseCpuMillicores(q.hard['requests.cpu']);
      const hardCpuLim  = parseCpuMillicores(q.hard['limits.cpu']);
      const hardMemReq  = parseMemMiB(q.hard['requests.memory']);
      const hardMemLim  = parseMemMiB(q.hard['limits.memory']);
      const usedCpuReq  = parseCpuMillicores(q.used['requests.cpu']);
      const usedCpuLim  = parseCpuMillicores(q.used['limits.cpu']);
      const usedMemReq  = parseMemMiB(q.used['requests.memory']);
      const usedMemLim  = parseMemMiB(q.used['limits.memory']);
      const hardPods    = q.hard['pods'] ? parseInt(q.hard['pods'], 10) : null;
      const usedPods    = q.used['pods'] ? parseInt(q.used['pods'], 10) : null;
      const hardPvcs    = q.hard['persistentvolumeclaims'] ? parseInt(q.hard['persistentvolumeclaims'], 10) : null;
      const usedPvcs    = q.used['persistentvolumeclaims'] ? parseInt(q.used['persistentvolumeclaims'], 10) : null;
      const hardStorage = parseMemMiB(q.hard['requests.storage']);
      const usedStorage = parseMemMiB(q.used['requests.storage']);

      return {
        namespace: q.namespace,
        // Raw formatted strings for display
        cpuRequest:     fmtCpu(hardCpuReq),
        cpuLimit:       fmtCpu(hardCpuLim),
        memRequest:     fmtMiB(hardMemReq),
        memLimit:       fmtMiB(hardMemLim),
        usedCpuRequest: fmtCpu(usedCpuReq),
        usedCpuLimit:   fmtCpu(usedCpuLim),
        usedMemRequest: fmtMiB(usedMemReq),
        usedMemLimit:   fmtMiB(usedMemLim),
        pods:           hardPods,
        usedPods:       usedPods,
        pvcs:           hardPvcs,
        usedPvcs:       usedPvcs,
        storage:        fmtMiB(hardStorage),
        usedStorage:    fmtMiB(usedStorage),
        // Usage percentages for progress bars
        cpuRequestPct:  usagePercent(usedCpuReq,  hardCpuReq),
        cpuLimitPct:    usagePercent(usedCpuLim,  hardCpuLim),
        memRequestPct:  usagePercent(usedMemReq,  hardMemReq),
        memLimitPct:    usagePercent(usedMemLim,  hardMemLim),
        podsPct:        usagePercent(usedPods,     hardPods),
        storagePct:     usagePercent(usedStorage,  hardStorage),
      };
    });
  } catch (err) {
    console.error('[k8s] listQuotas error:', err.message);
    return [];
  }
}

async function listEvents() {
  try {
    const events = await client.getAllEvents();
    return events.map(ev => ({
      namespace: ev.namespace,
      type:      ev.type    || 'Normal',
      reason:    ev.reason  || '—',
      message:   ev.message || '—',
      count:     ev.count   || 1,
      lastSeen:  timeAgo(ev.lastSeen),
    }));
  } catch (err) {
    console.error('[k8s] listEvents error:', err.message);
    return [];
  }
}

module.exports = { listPods, deletePod, scaleDeployment, listQuotas, listEvents };
