'use strict';

// Mock K8s service — replace with @kubernetes/client-node in post-MVP.
// All responses mirror real K8s API shape for easy swap.

const mockPods = [
  { name: 'cnp-portal-7d9f8b-xk2p9', namespace: 'cnp-portal', status: 'Running', restarts: 0, age: '2d', app: 'cnp-portal', owner: null },
  { name: 'cnp-portal-7d9f8b-mv3q1', namespace: 'cnp-portal', status: 'Running', restarts: 1, age: '2d', app: 'cnp-portal', owner: null },
  { name: 'app-alpha-6c5d7f-tz8r2',  namespace: 'default',    status: 'Running', restarts: 0, age: '5h', app: 'app-alpha',  owner: 'alice' },
  { name: 'app-beta-9e2a1c-wq4s7',   namespace: 'default',    status: 'CrashLoopBackOff', restarts: 12, age: '1h', app: 'app-beta', owner: 'bob' },
  { name: 'app-gamma-3b7c9d-pr5t6',  namespace: 'default',    status: 'Pending', restarts: 0, age: '10m', app: 'app-gamma', owner: 'alice' },
];

const mockQuotas = [
  { namespace: 'cnp-portal', cpuRequest: '100m', cpuLimit: '500m', memRequest: '128Mi', memLimit: '256Mi', usedCpuRequest: '80m', usedMemRequest: '100Mi' },
  { namespace: 'default',    cpuRequest: '500m', cpuLimit: '2000m', memRequest: '512Mi', memLimit: '1Gi',  usedCpuRequest: '320m', usedMemRequest: '400Mi' },
];

const mockEvents = [
  { namespace: 'default', reason: 'BackOff', message: 'Back-off restarting failed container app-beta', type: 'Warning', count: 24, lastSeen: '5m ago' },
  { namespace: 'cnp-portal', reason: 'Pulled', message: 'Successfully pulled image registry.gitlab.com/cnp/cnp-portal:1.0.0', type: 'Normal', count: 1, lastSeen: '2d ago' },
  { namespace: 'default', reason: 'Scheduled', message: 'Successfully assigned default/app-gamma to node-1', type: 'Normal', count: 1, lastSeen: '10m ago' },
];

const deploymentReplicas = new Map([
  ['cnp-portal', 2],
  ['app-alpha', 1],
  ['app-beta', 1],
  ['app-gamma', 1],
]);

async function listPods(ownerFilter = null) {
  if (ownerFilter) {
    return mockPods.filter(p => p.owner === ownerFilter || p.owner === null);
  }
  return mockPods;
}

async function deletePod(podName) {
  const idx = mockPods.findIndex(p => p.name === podName);
  if (idx === -1) throw new Error('Pod not found');
  mockPods.splice(idx, 1);
  return { deleted: podName };
}

async function scaleDeployment(deploymentName, replicas) {
  if (replicas < 0 || replicas > 10) throw new Error('Invalid replica count (0-10)');
  deploymentReplicas.set(deploymentName, replicas);
  return { deployment: deploymentName, replicas };
}

async function getReplicas(deploymentName) {
  return deploymentReplicas.get(deploymentName) || 1;
}

async function listQuotas() {
  return mockQuotas;
}

async function listEvents() {
  return mockEvents;
}

module.exports = { listPods, deletePod, scaleDeployment, getReplicas, listQuotas, listEvents };
