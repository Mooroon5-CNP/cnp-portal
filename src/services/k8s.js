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

async function listQuotas() {
  try {
    const quotas = await client.getAllResourceQuotas();
    return quotas.map(q => ({
      namespace:      q.namespace,
      cpuRequest:     q.hard['requests.cpu']    || '—',
      cpuLimit:       q.hard['limits.cpu']      || '—',
      memRequest:     q.hard['requests.memory'] || '—',
      memLimit:       q.hard['limits.memory']   || '—',
      usedCpuRequest: q.used['requests.cpu']    || '0',
      usedMemRequest: q.used['requests.memory'] || '0',
    }));
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
