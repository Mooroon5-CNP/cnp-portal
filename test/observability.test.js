'use strict';

// Per-app observability: Datadog client, service, silence/unsilence routes and the
// deployment-detail tab. Datadog is always mocked — these tests never hit the network.

jest.mock('axios', () => {
  const instance = { get: jest.fn(), post: jest.fn() };
  return { create: jest.fn(() => instance), __instance: instance };
});
jest.mock('../src/services/datadog');

const path = require('path');
const ejs = require('ejs');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const http = axios.__instance;
process.env.DD_API_KEY = 'test-api-key';
process.env.DD_APP_KEY = 'test-app-key';

const ddClient = jest.requireActual('../src/clients/datadog');
const ddServiceActual = jest.requireActual('../src/services/datadog');
const ddServiceMock = require('../src/services/datadog');
const userStore = require('../src/models/user');
const deploymentModel = require('../src/models/deployment');
const app = require('../src/index');

const TAB = path.join(__dirname, '../src/views/partials/observability-tab.ejs');

const NO_KUBE = { pods: '—', cpu: '—', memory: '—', restarts: '—' };

const EMPTY_METRICS = {
  latency: { p50: '—', p95: '—', p99: '—', unit: 'ms' },
  errorRate: { value: '—', unit: '%' },
  saturation: { cpu: '—', memory: '—', unit: '%' },
  traffic: { rps: '—', unit: 'req/s' },
  cloudRun: { requests: '—', cpu: '—', memory: '—' },
  kubernetes: { dev: NO_KUBE, prod: NO_KUBE },
};

const WITH_METRICS = {
  latency: { p50: 12, p95: 80, p99: 210, unit: 'ms' },
  errorRate: { value: 0.4, unit: '%' },
  saturation: { cpu: 31.5, memory: 47.2, unit: '%' },
  traffic: { rps: 5.3, unit: 'req/s' },
  cloudRun: { requests: 1234, cpu: 22.1, memory: 40.8 },
  kubernetes: {
    dev: { pods: 2, cpu: 35.5, memory: 210, restarts: 0 },
    prod: { pods: 3, cpu: 120.2, memory: 480, restarts: 4 },
  },
};

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe('Datadog client — silence / unsilence', () => {
  test('silenceMonitor POSTs to /mute', async () => {
    http.post.mockResolvedValue({ data: { id: 42 } });
    await ddClient.silenceMonitor(42);
    expect(http.post).toHaveBeenCalledWith('/api/v1/monitor/42/mute', {});
  });

  test('unsilenceMonitor POSTs to /unmute', async () => {
    http.post.mockResolvedValue({ data: { id: 42 } });
    const data = await ddClient.unsilenceMonitor(42);
    expect(http.post).toHaveBeenCalledWith('/api/v1/monitor/42/unmute', {});
    expect(data).toEqual({ id: 42 });
  });

  test('unsilenceMonitor turns an API error into a readable message', async () => {
    http.post.mockRejectedValue({ response: { status: 404, data: { errors: ['Monitor not found'] } }, message: 'x' });
    await expect(ddClient.unsilenceMonitor(1)).rejects.toThrow('Datadog API error (404) on unsilenceMonitor(1): Monitor not found');
  });
});

describe('Datadog client — getGoldenSignals', () => {
  const series = value => ({ data: { series: [{ pointlist: [[1, null], [2, value]] }] } });

  test('returns "—" everywhere when Datadog has no data, without throwing', async () => {
    http.get.mockResolvedValue({ data: { series: [] } });
    const m = await ddClient.getGoldenSignals('my-app');
    expect(m.latency.p50).toBe('—');
    expect(m.traffic.rps).toBe('—');
    expect(m.cloudRun).toEqual({ requests: '—', cpu: '—', memory: '—' });
  });

  test('a failing Cloud Run query does not affect the golden signals', async () => {
    http.get.mockImplementation((_url, { params }) => {
      if (params.query.startsWith('sum:gcp.run')) return Promise.reject(new Error('boom'));
      if (params.query.includes('duration.by.service.p50')) return Promise.resolve(series(12e6));
      return Promise.resolve({ data: { series: [] } });
    });
    const m = await ddClient.getGoldenSignals('my-app');
    expect(m.latency.p50).toBe(12);
    expect(m.cloudRun.requests).toBe('—');
  });

  test('scopes every query to the requested app and converts Cloud Run units', async () => {
    http.get.mockImplementation((_url, { params }) => {
      if (params.query.startsWith('sum:gcp.run.request_count')) return Promise.resolve(series(1234.4));
      if (params.query.includes('gcp.run.container.cpu')) return Promise.resolve(series(0.225));
      if (params.query.includes('gcp.run.container.memory')) return Promise.resolve(series(0.5));
      return Promise.resolve({ data: { series: [] } });
    });
    const m = await ddClient.getGoldenSignals('my-app');

    const queries = http.get.mock.calls.map(([, { params }]) => params.query);
    expect(queries).toHaveLength(10);
    queries.filter(q => q.startsWith('sum:gcp.run') || q.includes('gcp.run.container'))
      .forEach(q => expect(q).toContain('{service_name:my-app}'));
    queries.filter(q => !q.includes('gcp.run')).forEach(q => expect(q).toContain('{service:my-app}'));

    expect(m.cloudRun).toEqual({ requests: 1234, cpu: 22.5, memory: 50 });
  });
});

describe('Datadog client — getKubernetesUsage', () => {
  const seriesFor = (ns, value) => ({ scope: `kube_namespace:${ns},(kube_namespace:a-dev OR kube_namespace:a-prod)`, pointlist: [[1, null], [2, value]] });

  test('issues one grouped query per metric with an exact OR scope', async () => {
    http.get.mockResolvedValue({ data: { series: [] } });
    await ddClient.getKubernetesUsage(['a-dev', 'a-prod']);
    const queries = http.get.mock.calls.map(([, { params }]) => params.query);
    expect(queries).toHaveLength(4);
    queries.forEach(q => {
      expect(q).toContain('{kube_namespace:a-dev OR kube_namespace:a-prod} by {kube_namespace}');
    });
  });

  test('converts nanocores to mCPU and bytes to MiB, per namespace', async () => {
    http.get.mockImplementation((_url, { params }) => {
      const q = params.query;
      if (q.includes('kubernetes.cpu.usage.total')) return Promise.resolve({ data: { series: [seriesFor('a-dev', 35.5e6), seriesFor('a-prod', 120.2e6)] } });
      if (q.includes('kubernetes.memory.usage')) return Promise.resolve({ data: { series: [seriesFor('a-dev', 210 * 1048576)] } });
      if (q.includes('kubernetes.pods.running')) return Promise.resolve({ data: { series: [seriesFor('a-dev', 2), seriesFor('a-prod', 3)] } });
      if (q.includes('container.restarts')) return Promise.resolve({ data: { series: [seriesFor('a-prod', 4)] } });
      return Promise.resolve({ data: { series: [] } });
    });
    const usage = await ddClient.getKubernetesUsage(['a-dev', 'a-prod']);
    expect(usage['a-dev']).toEqual({ pods: 2, cpu: 35.5, memory: 210, restarts: '—' });
    expect(usage['a-prod']).toEqual({ pods: 3, cpu: 120.2, memory: '—', restarts: 4 });
  });

  test('returns "—" for a namespace that reports nothing', async () => {
    http.get.mockResolvedValue({ data: { series: [] } });
    expect(await ddClient.getKubernetesUsage(['a-dev'])).toEqual({ 'a-dev': NO_KUBE });
  });

  test('a failing metric query only blanks that metric', async () => {
    http.get.mockImplementation((_url, { params }) => (params.query.includes('kubernetes.memory.usage')
      ? Promise.reject(new Error('boom'))
      : Promise.resolve({ data: { series: [seriesFor('a-dev', 3)] } })));
    const usage = await ddClient.getKubernetesUsage(['a-dev']);
    expect(usage['a-dev'].memory).toBe('—');
    expect(usage['a-dev'].pods).toBe(3);
  });

  test('ignores namespaces that were not requested', async () => {
    http.get.mockResolvedValue({ data: { series: [seriesFor('other-ns', 9)] } });
    expect(await ddClient.getKubernetesUsage(['a-dev'])).toEqual({ 'a-dev': NO_KUBE });
  });
});

// ---------------------------------------------------------------------------
describe('Datadog service', () => {
  test('unsilenceAlert converts the id to a number and delegates to the client', async () => {
    http.post.mockResolvedValue({ data: {} });
    await ddServiceActual.unsilenceAlert('42');
    expect(http.post).toHaveBeenCalledWith('/api/v1/monitor/42/unmute', {});
  });

  test('getMetrics(appName) queries that app, not the portal', async () => {
    http.get.mockResolvedValue({ data: { series: [] } });
    await ddServiceActual.getMetrics('my-app');
    expect(http.get.mock.calls.every(([, { params }]) => params.query.includes('my-app'))).toBe(true);
  });

  test('getMetrics(appName) adds Kubernetes usage for {app}-dev and {app}-prod', async () => {
    http.get.mockImplementation((_url, { params }) => {
      const q = params.query;
      if (q.includes('kubernetes.pods.running')) {
        return Promise.resolve({ data: { series: [{ scope: 'kube_namespace:my-app-prod,(x)', pointlist: [[1, 3]] }] } });
      }
      return Promise.resolve({ data: { series: [] } });
    });
    const m = await ddServiceActual.getMetrics('my-app');
    expect(m.kubernetes.prod.pods).toBe(3);
    expect(m.kubernetes.dev).toEqual(NO_KUBE);
    const k8sQuery = http.get.mock.calls.map(([, { params }]) => params.query).find(q => q.includes('kubernetes.pods.running'));
    expect(k8sQuery).toContain('kube_namespace:my-app-dev OR kube_namespace:my-app-prod');
  });

  test('getMetrics() without an app does not query Kubernetes', async () => {
    http.get.mockResolvedValue({ data: { series: [] } });
    const m = await ddServiceActual.getMetrics();
    expect(m.kubernetes).toBeUndefined();
    expect(http.get.mock.calls.some(([, { params }]) => params.query.includes('kubernetes'))).toBe(false);
  });

  test('getMetrics falls back to a full "—" shape including cloudRun when Datadog fails', async () => {
    http.get.mockImplementation(() => { throw new Error('unreachable'); });
    const m = await ddServiceActual.getMetrics('my-app');
    expect(m).toEqual(EMPTY_METRICS);
  });

  test('getAlerts maps monitor state and silenced flag', async () => {
    http.get.mockResolvedValue({
      data: [
        { id: 1, name: 'A', query: 'q', tags: ['service:my-app'], overall_state: 'Alert', options: { silenced: { '*': null } } },
        { id: 2, name: 'B', query: 'q', tags: ['service:my-app'], overall_state: 'OK', options: { silenced: {} } },
      ],
    });
    const alerts = await ddServiceActual.getAlerts('my-app');
    expect(alerts.map(a => [a.id, a.status, a.silenced])).toEqual([['1', 'ALERT', true], ['2', 'OK', false]]);
    expect(http.get).toHaveBeenCalledWith('/api/v1/monitor', { params: { monitor_tags: 'service:my-app' } });
  });
});

// ---------------------------------------------------------------------------
describe('Observability tab partial', () => {
  const baseDeployment = { id: 'dep-1', appName: 'my-app', targetCluster: 'gcp', cloudRunUrl: null };
  const render = (locals = {}) => ejs.renderFile(TAB, {
    deployment: baseDeployment,
    ddMetrics: WITH_METRICS,
    ddLogs: [],
    ddAlerts: [],
    can: () => true,
    ...locals,
  });

  test('shows the unavailable message when Datadog returned nothing', async () => {
    const html = await render({ ddMetrics: null });
    expect(html).toContain('Données Datadog indisponibles');
  });

  test('hides the latency/error/traffic cards, with a discreet note, when there is no APM data', async () => {
    const html = await render({ ddMetrics: EMPTY_METRICS });
    expect(html).not.toContain('Latence (p50');
    expect(html).not.toContain("Taux d'erreur");
    expect(html).not.toContain('metric-card');
    expect(html).toContain('masqués');
    expect(html).toContain('service:my-app');
  });

  test('shows the latency/error/traffic cards when APM data is present', async () => {
    const html = await render();
    expect(html).toContain('Latence (p50');
    expect(html).toContain("Taux d'erreur");
    expect(html).toContain('Trafic');
    expect(html).not.toContain('masqués');
  });

  test('a single golden signal with data is enough to show the cards', async () => {
    const html = await render({ ddMetrics: { ...EMPTY_METRICS, traffic: { rps: 2.5, unit: 'req/s' } } });
    expect(html).toContain('Latence (p50');
  });

  test('renders the Kubernetes table per environment and flags restarts', async () => {
    const html = await render();
    expect(html).toContain('my-app-dev');
    expect(html).toContain('my-app-prod');
    expect(html).toContain('480');
    expect(html).toContain('color: var(--danger)');
  });

  test('explains when no pod is found in either namespace', async () => {
    const html = await render({ ddMetrics: { ...WITH_METRICS, kubernetes: EMPTY_METRICS.kubernetes } });
    expect(html).toContain('Aucun pod détecté dans');
    expect(html).not.toContain('Redémarrages');
  });

  test('does not crash when the metrics have no kubernetes block', async () => {
    const { kubernetes, ...withoutKube } = WITH_METRICS; // eslint-disable-line no-unused-vars
    const html = await render({ ddMetrics: withoutKube });
    expect(html).toContain('Aucun pod détecté dans');
  });

  test('renders metrics and the Cloud Run card for a GCP app with data', async () => {
    const html = await render();
    expect(html).not.toContain('masqués');
    expect(html).toContain('Cloud Run (GCP)');
    expect(html).toContain('1234');
  });

  test('hides the Cloud Run card for a non-GCP app', async () => {
    const html = await render({ deployment: { ...baseDeployment, targetCluster: 'aws' } });
    expect(html).not.toContain('Cloud Run (GCP)');
  });

  test('hides the Cloud Run card when there is no Cloud Run URL and no data', async () => {
    const html = await render({ ddMetrics: { ...WITH_METRICS, cloudRun: EMPTY_METRICS.cloudRun } });
    expect(html).not.toContain('Cloud Run (GCP)');
  });

  test('shows the Cloud Run card once a Cloud Run URL is known, even without data', async () => {
    const html = await render({
      ddMetrics: EMPTY_METRICS,
      deployment: { ...baseDeployment, cloudRunUrl: 'https://my-app.run.app' },
    });
    expect(html).toContain('Cloud Run (GCP)');
  });

  test('offers "Silencer" for an active alert and "Réactiver" for a silenced one', async () => {
    const html = await render({
      ddAlerts: [
        { id: '1', name: 'Active', query: 'q', status: 'OK', silenced: false },
        { id: '2', name: 'Muted', query: 'q', status: 'OK', silenced: true },
      ],
    });
    expect(html).toContain('action="/observability/monitors/1/silence"');
    expect(html).toContain('action="/observability/monitors/2/unsilence"');
    expect(html).toContain('name="redirectTo" value="/deployments/dep-1"');
  });

  test('hides silence controls without the permission', async () => {
    const html = await render({
      can: () => false,
      ddAlerts: [{ id: '1', name: 'Active', query: 'q', status: 'OK', silenced: false }],
    });
    expect(html).not.toContain('/observability/monitors/');
  });

  test('escapes log messages', async () => {
    const html = await render({
      ddLogs: [{ timestamp: new Date().toISOString(), level: 'INFO', service: 'my-app', message: '<script>alert(1)</script>' }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

// ---------------------------------------------------------------------------
describe('Silence / unsilence routes', () => {
  async function login(username, password) {
    const agent = request.agent(app);
    const res = await agent.post('/auth/login').type('form').send({ username, password });
    expect(res.status).toBe(302);
    return agent;
  }

  test('require authentication', async () => {
    const res = await request(app).post('/observability/monitors/1/silence').type('form').send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
    expect(ddServiceMock.silenceAlert).not.toHaveBeenCalled();
  });

  test('a dev cannot silence or unsilence', async () => {
    userStore.create({
      username: 'obs-dev', role: 'dev', active: 1, approved: 1,
      passwordHash: bcrypt.hashSync('pw', 4),
    });
    const agent = await login('obs-dev', 'pw');
    const silence = await agent.post('/observability/monitors/1/silence').type('form').send({});
    const unsilence = await agent.post('/observability/monitors/1/unsilence').type('form').send({});
    expect(silence.status).toBe(403);
    expect(unsilence.status).toBe(403);
    expect(ddServiceMock.silenceAlert).not.toHaveBeenCalled();
    expect(ddServiceMock.unsilenceAlert).not.toHaveBeenCalled();
  });

  describe('as a manager', () => {
    let agent;
    beforeAll(async () => { agent = await login('admin', 'admin'); });

    test('silence calls the service and redirects back to redirectTo', async () => {
      ddServiceMock.silenceAlert.mockResolvedValue({});
      const res = await agent.post('/observability/monitors/42/silence').type('form').send({ redirectTo: '/deployments/dep-1' });
      expect(ddServiceMock.silenceAlert).toHaveBeenCalledWith('42');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/deployments/dep-1');
    });

    test('unsilence calls the service and redirects back to redirectTo', async () => {
      ddServiceMock.unsilenceAlert.mockResolvedValue({});
      const res = await agent.post('/observability/monitors/42/unsilence').type('form').send({ redirectTo: '/deployments/dep-1' });
      expect(ddServiceMock.unsilenceAlert).toHaveBeenCalledWith('42');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/deployments/dep-1');
    });

    test('defaults to the alerts page when redirectTo is missing', async () => {
      ddServiceMock.silenceAlert.mockResolvedValue({});
      const res = await agent.post('/observability/monitors/42/silence').type('form').send({});
      expect(res.headers.location).toBe('/observability/alerts');
    });

    test.each([
      ['an absolute URL', 'https://evil.example/x'],
      ['a protocol-relative URL', '//evil.example/x'],
      ['a backslash variant', '/\\evil.example/x'],
    ])('rejects %s as redirectTo (no open redirect)', async (_label, target) => {
      ddServiceMock.silenceAlert.mockResolvedValue({});
      const res = await agent.post('/observability/monitors/42/silence').type('form').send({ redirectTo: target });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/observability/alerts');
    });

    test('still redirects (with an error flash) when Datadog fails', async () => {
      ddServiceMock.unsilenceAlert.mockRejectedValue(new Error('Datadog rate limit exceeded.'));
      const res = await agent.post('/observability/monitors/42/unsilence').type('form').send({ redirectTo: '/deployments/dep-1' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/deployments/dep-1');
    });
  });
});

// ---------------------------------------------------------------------------
describe('GET /deployments/:id — observability tab', () => {
  let agent;
  let readyDep;
  let configuringDep;

  beforeAll(async () => {
    const admin = userStore.findByUsername('admin');
    const make = appName => deploymentModel.create({
      appName, githubRepoUrl: `https://github.com/org/${appName}`, appPort: 3000,
      configRepoToken: 'x', ownerUserId: admin.id,
    });
    readyDep = make('obs-ready');
    deploymentModel.updateOnboardingStatus(readyDep.id, 'ready');
    configuringDep = make('obs-configuring');

    agent = request.agent(app);
    await agent.post('/auth/login').type('form').send({ username: 'admin', password: 'admin' });
  });

  test('fetches Datadog data for that app and renders the tab', async () => {
    ddServiceMock.getLogs.mockResolvedValue([
      { timestamp: new Date().toISOString(), level: 'INFO', service: 'obs-ready', message: 'hello from obs-ready' },
    ]);
    ddServiceMock.getMetrics.mockResolvedValue(WITH_METRICS);
    ddServiceMock.getAlerts.mockResolvedValue([{ id: '7', name: 'High latency', query: 'q', status: 'ALERT', silenced: false }]);

    const res = await agent.get(`/deployments/${readyDep.id}`);

    expect(res.status).toBe(200);
    expect(ddServiceMock.getLogs).toHaveBeenCalledWith('obs-ready');
    expect(ddServiceMock.getMetrics).toHaveBeenCalledWith('obs-ready');
    expect(ddServiceMock.getAlerts).toHaveBeenCalledWith('obs-ready');
    expect(res.text).toContain('id="tab-observability"');
    expect(res.text).toContain('hello from obs-ready');
    expect(res.text).toContain('High latency');
    expect(res.text).toContain('/observability/monitors/7/silence');
  });

  test('still renders the page when Datadog calls reject', async () => {
    ddServiceMock.getLogs.mockRejectedValue(new Error('down'));
    ddServiceMock.getMetrics.mockRejectedValue(new Error('down'));
    ddServiceMock.getAlerts.mockRejectedValue(new Error('down'));

    const res = await agent.get(`/deployments/${readyDep.id}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Données Datadog indisponibles');
    expect(res.text).toContain('Aucun log disponible');
    expect(res.text).toContain('Aucune alerte configurée');
  });

  test('does not query Datadog while the app is still onboarding', async () => {
    const res = await agent.get(`/deployments/${configuringDep.id}`);
    expect(res.status).toBe(200);
    expect(ddServiceMock.getLogs).not.toHaveBeenCalled();
    expect(ddServiceMock.getMetrics).not.toHaveBeenCalled();
    expect(ddServiceMock.getAlerts).not.toHaveBeenCalled();
  });
});
