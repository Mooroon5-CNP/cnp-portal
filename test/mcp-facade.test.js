'use strict';

const express = require('express');
const request = require('supertest');
const { z } = require('zod');
const { createMcpFacadeRouter, SourceError } = require('../src/routes/mcp-facade');

// Exact response contract of MCP-CNP apps/mcp-server/src/http-adapters.ts (feat/gca-integration).
const environment = z.enum(['dev', 'prod']);
const application = z.strictObject({ applicationId: z.string(), name: z.string(), team: z.string(), repositoryUrl: z.string(),
  environments: z.array(z.strictObject({ name: environment, enabled: z.boolean() })) });
const contract = {
  list: z.strictObject({ applications: z.array(application), nextCursor: z.string().nullable() }),
  application: application.nullable(),
  workload: z.strictObject({ platform: z.enum(['gke', 'cloud_run']), stateless: z.boolean(), http: z.boolean(), requiresKubernetes: z.boolean() }).nullable(),
  desired: z.strictObject({ version: z.string().nullable(), imageDigest: z.string().nullable(), sourceRevision: z.string().nullable() }),
  observed: z.strictObject({ version: z.string().nullable(), imageDigest: z.string().nullable(), syncStatus: z.enum(['Synced', 'OutOfSync', 'Unknown']),
    healthStatus: z.enum(['Healthy', 'Progressing', 'Degraded', 'Unknown']), lastDeploymentAt: z.iso.datetime().nullable() }),
  digest: z.string().nullable(),
  logs: z.strictObject({ logs: z.array(z.strictObject({ timestamp: z.iso.datetime(), level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'UNKNOWN']),
    message: z.string(), service: z.string(), version: z.string().nullable(), correlationId: z.string().nullable() })),
  nextCursor: z.string().nullable(), truncated: z.boolean(), partialFailure: z.string().optional() }),
  metrics: z.strictObject({ averageCpuPercent: z.number().nullable(), peakCpuPercent: z.number().nullable(),
    averageMemoryPercent: z.number().nullable(), peakMemoryPercent: z.number().nullable(), coverageDays: z.number().int().nonnegative() }),
};

const TOKEN = 'facade-token-for-tests-0123456789abcdef';
const app1 = { applicationId: 'app-2-dancingduck', name: 'app-2-dancingduck', team: 'team-a',
  repositoryUrl: 'https://github.com/org/app', environments: [{ name: 'dev', enabled: true }] };

function fakeAdapters() {
  return {
    platform: { mode: 'real',
      list: jest.fn(async () => ({ applications: [app1], nextCursor: null })),
      get: jest.fn(async appId => (appId === app1.applicationId ? app1 : null)),
      workload: jest.fn(async () => ({ platform: 'cloud_run', stateless: false, http: true, requiresKubernetes: false })) },
    git: { mode: 'real', desired: jest.fn(async () => ({ version: null, imageDigest: `sha256:${'a'.repeat(64)}`, sourceRevision: null })) },
    argo: { mode: 'real', observed: jest.fn(async () => ({ version: null, imageDigest: null, syncStatus: 'Synced',
      healthStatus: 'Healthy', lastDeploymentAt: '2026-11-23T11:51:56.790Z' })) },
    kubernetes: { mode: 'real', imageDigest: jest.fn(async () => { throw new SourceError('SOURCE_NOT_CONFIGURED', 'kubernetes'); }) },
    datadog: { mode: 'real',
      logs: jest.fn(async () => ({ logs: [{ timestamp: '2026-11-23T11:00:00.000Z', level: 'INFO', message: 'ok', service: 'app',
        version: null, correlationId: null }], nextCursor: null, truncated: false })),
      metrics: jest.fn(async () => ({ averageCpuPercent: 3, peakCpuPercent: 9, averageMemoryPercent: 20, peakMemoryPercent: 30, coverageDays: 7 })) },
  };
}

function build(options = {}) {
  const adapters = fakeAdapters();
  const app = express();
  app.use('/v1', createMcpFacadeRouter({ token: TOKEN, adapters, ...options }));
  app.use((_req, res) => res.status(404).send('portal 404'));
  return { app, adapters, get: (path, token = TOKEN) => request(app).get(path).set('Authorization', `Bearer ${token}`) };
}

describe('MCP source facades', () => {
  test('every route answers with the exact MCP-CNP contract', async () => {
    const { get } = build();
    const cases = [
      ['/v1/applications?limit=20', contract.list],
      ['/v1/applications/app-2-dancingduck', contract.application],
      ['/v1/applications/unknown-app', contract.application],
      ['/v1/applications/app-2-dancingduck/dev/workload', contract.workload],
      ['/v1/desired-state/app-2-dancingduck/dev', contract.desired],
      ['/v1/deployment-status/app-2-dancingduck/dev', contract.observed],
      ['/v1/logs?applicationId=app-2-dancingduck&environment=dev&from=2026-11-23T10:00:00.000Z&to=2026-11-23T11:00:00.000Z&limit=50&levels=WARN,ERROR', contract.logs],
      ['/v1/metrics/app-2-dancingduck/dev?days=7', contract.metrics],
    ];
    for (const [path, schema] of cases) {
      const res = await get(path);
      expect([path, res.status]).toEqual([path, 200]);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(() => schema.parse(res.body)).not.toThrow();
    }
  });

  test('passes typed, validated arguments to the native adapters', async () => {
    const { get, adapters } = build();
    await get('/v1/applications?query=duck&environment=dev&limit=5&cursor=10');
    expect(adapters.platform.list).toHaveBeenCalledWith({ query: 'duck', environment: 'dev', limit: 5, cursor: '10' });
    await get('/v1/logs?applicationId=app-2-dancingduck&environment=prod&from=2026-11-23T10:00:00Z&to=2026-11-23T11:00:00Z&levels=ERROR,WARN,ERROR&query=timeout');
    expect(adapters.datadog.logs).toHaveBeenCalledWith({ applicationId: 'app-2-dancingduck', environment: 'prod',
      from: '2026-11-23T10:00:00Z', to: '2026-11-23T11:00:00Z', limit: 50, levels: ['ERROR', 'WARN'], query: 'timeout', cursor: undefined });
    await get('/v1/metrics/app-2-dancingduck/prod?days=30');
    expect(adapters.datadog.metrics).toHaveBeenCalledWith('app-2-dancingduck', 'prod', 30);
  });

  test('accepts the largest inputs allowed by the MCP contract', async () => {
    const { get, adapters } = build();
    const window = 'applicationId=app&environment=dev&from=2026-11-23T10:00:00Z&to=2026-11-23T11:00:00Z';
    expect((await get(`/v1/logs?${window}&limit=200&cursor=${'c'.repeat(1000)}`)).status).toBe(200);
    expect(adapters.datadog.logs).toHaveBeenCalledWith(expect.objectContaining({ limit: 200, cursor: 'c'.repeat(1000) }));
    expect((await get(`/v1/logs?${window}&limit=201`)).status).toBe(400);
    expect((await get('/v1/applications?limit=100')).status).toBe(200);
  });

  test('refuses a missing or wrong token without calling any source', async () => {
    const { app, adapters, get } = build();
    const none = await request(app).get('/v1/applications');
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect((await get('/v1/applications', `${TOKEN}x`)).status).toBe(401);
    expect((await request(app).get('/v1/applications').set('Authorization', TOKEN)).status).toBe(401);
    expect(adapters.platform.list).not.toHaveBeenCalled();
  });

  test('is read-only', async () => {
    const { app } = build();
    const res = await request(app).post('/v1/applications').set('Authorization', `Bearer ${TOKEN}`).send({});
    expect(res.status).toBe(405);
  });

  test('rejects malformed input before reaching a source', async () => {
    const { get, adapters } = build();
    const bad = [
      '/v1/applications/..%2Fsecret',
      '/v1/applications/app-2-dancingduck/staging/workload',
      '/v1/applications?limit=0',
      '/v1/applications?limit=1000',
      '/v1/applications?environment=qa',
      '/v1/applications?query=%22%20OR%20service%3A*',
      '/v1/logs?applicationId=app&environment=dev&from=yesterday&to=2026-11-23T11:00:00Z',
      '/v1/logs?applicationId=app&environment=dev&from=2026-11-23T12:00:00Z&to=2026-11-23T11:00:00Z',
      '/v1/logs?applicationId=app&environment=dev&from=2026-11-23T10:00:00Z&to=2026-11-23T11:00:00Z&levels=TRACE',
      '/v1/metrics/app/dev?days=8',
    ];
    for (const path of bad) expect([path, (await get(path)).status]).toEqual([path, 400]);
    expect(adapters.platform.list).not.toHaveBeenCalled();
    expect(adapters.datadog.logs).not.toHaveBeenCalled();
    expect(adapters.datadog.metrics).not.toHaveBeenCalled();
  });

  test('maps source errors to the statuses the MCP understands, without details', async () => {
    const { get, adapters } = build();
    adapters.git.desired.mockRejectedValueOnce(new SourceError('APPLICATION_NOT_FOUND', 'git'));
    expect((await get('/v1/desired-state/missing/dev')).status).toBe(404);
    const unconfigured = await get('/v1/image-digest/app-2-dancingduck/dev');
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body).toEqual({ error: 'SOURCE_NOT_CONFIGURED' });
    adapters.argo.observed.mockRejectedValueOnce(new Error('token=secret leaked'));
    const crash = await get('/v1/deployment-status/app-2-dancingduck/dev');
    expect(crash.status).toBe(503);
    expect(JSON.stringify(crash.body)).not.toContain('secret');
  });

  test('does not exist without a strong token', async () => {
    for (const token of [undefined, '', 'short-token']) {
      const app = express();
      app.use('/v1', createMcpFacadeRouter({ token, adapters: fakeAdapters() }));
      app.use((_req, res) => res.status(404).send('portal 404'));
      const res = await request(app).get('/v1/applications').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
      expect(res.text).toBe('portal 404');
    }
  });
});

describe('portal mounting', () => {
  test('/v1 is mounted before the session: no cookie and no login redirect', async () => {
    const previous = process.env.MCP_FACADE_TOKEN;
    process.env.MCP_FACADE_TOKEN = TOKEN;
    try {
      let app;
      jest.isolateModules(() => { app = require('../src/index'); });
      const res = await request(app).get('/v1/applications').set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.MCP_FACADE_TOKEN; else process.env.MCP_FACADE_TOKEN = previous;
    }
  });

  test('without MCP_FACADE_TOKEN the portal behaves as before on /v1', async () => {
    const previous = process.env.MCP_FACADE_TOKEN;
    delete process.env.MCP_FACADE_TOKEN;
    try {
      let app;
      jest.isolateModules(() => { app = require('../src/index'); });
      const res = await request(app).get('/v1/applications').set('Authorization', `Bearer ${TOKEN}`);
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(401);
    } finally {
      if (previous !== undefined) process.env.MCP_FACADE_TOKEN = previous;
    }
  });
});
