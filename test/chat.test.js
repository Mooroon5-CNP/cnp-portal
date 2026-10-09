'use strict';

const request = require('supertest');
const app = require('../src/index');
const chatService = require('../src/services/chat');
const deploymentModel = require('../src/models/deployment');

const TURN_URL = '/api/v1/mcp/chat/turn';
const ENV_KEYS = ['AI_CLIENT_MODE', 'AI_CLIENT_URL', 'AI_CLIENT_STUB_DELAY_MS', 'AI_CLIENT_TIMEOUT_MS', 'CHAT_INTERNAL_TOKEN_SECRET'];

function parseEvents(text) {
  return text.split(/\n\n/).filter(Boolean).map(block => {
    const type = (block.match(/^event: (.*)$/m) || [])[1];
    const data = (block.match(/^data: (.*)$/m) || [])[1];
    return { type, data: data ? JSON.parse(data) : null };
  });
}

async function loggedInAgent() {
  const agent = request.agent(app);
  await agent.post('/auth/login').type('form').send({ username: 'admin', password: 'admin' });
  return agent;
}

function turn(agent, message, context = {}) {
  return agent.post(TURN_URL).set('Content-Type', 'application/json').send({ message, context });
}

describe('Chat — authentication', () => {
  test('GET /chat redirects to login when unauthenticated', async () => {
    const res = await request(app).get('/chat');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/auth/login');
  });

  test('chat API returns a JSON 401 (no redirect) when unauthenticated', async () => {
    const res = await request(app).post(TURN_URL).send({ message: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(res.body.category).toBe('forbidden');
  });

  test('an authenticated user can open the chat from the portal', async () => {
    const agent = await loggedInAgent();
    const res = await agent.get('/chat');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Assistant CNP');
    expect(res.text).toContain('href="/chat"');
    expect(res.text).toContain('/js/chat.js');
  });

  test('cross-origin requests are rejected', async () => {
    const agent = await loggedInAgent();
    const res = await turn(agent, 'liste les applications').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });

  test('invalid input is rejected', async () => {
    const agent = await loggedInAgent();
    const res = await turn(agent, '   ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_INPUT');
  });
});

describe('Chat — streamed turns (stub AI client)', () => {
  const saved = {};
  let agent;

  beforeAll(async () => {
    ENV_KEYS.forEach(k => { saved[k] = process.env[k]; });
    process.env.AI_CLIENT_MODE = 'stub';
    process.env.AI_CLIENT_STUB_DELAY_MS = '0';
    deploymentModel.create({ appName: 'cnp-test-node', githubRepoUrl: 'https://github.com/x/cnp-test-node', appPort: 8080, ownerUserId: 'u1' });
    agent = await loggedInAgent();
  });
  afterAll(() => ENV_KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

  test('streams tool progress, sources, structured data and completion', async () => {
    const res = await turn(agent, 'Montre les dernières erreurs dans les logs', { applicationId: 'cnp-test-node', environment: 'dev' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const types = parseEvents(res.text).map(e => e.type);
    expect(types).toEqual(expect.arrayContaining(['tool_status', 'source', 'structured', 'answer_delta', 'completed']));
    const completed = parseEvents(res.text).find(e => e.type === 'completed');
    expect(completed.data.correlationId).toBe(res.headers['x-correlation-id']);
  });

  test('partial results carry warnings and sources', async () => {
    const res = await turn(agent, 'As-tu une recommandation FinOps pour cnp-test-node ?');
    const events = parseEvents(res.text);
    const warning = events.find(e => e.type === 'warning');
    expect(warning.data.code).toBe('FINOPS_COST_DATA_UNAVAILABLE');
    expect(events.filter(e => e.type === 'source').length).toBeGreaterThan(0);
    expect(events.find(e => e.type === 'completed').data.status).toBe('partial');
  });

  test('ambiguous requests are clarified without invoking an MCP tool', async () => {
    const res = await turn(agent, 'Montre les logs');
    const events = parseEvents(res.text);
    expect(events.some(e => e.type === 'clarification_required')).toBe(true);
    expect(events.some(e => e.type === 'tool_status')).toBe(false);
  });

  test('mutation requests are rejected as outside the read-only MVP', async () => {
    const res = await turn(agent, 'Déploie cnp-test-node en prod');
    const events = parseEvents(res.text);
    const rejected = events.find(e => e.type === 'rejected');
    expect(rejected.data.message).toBe(chatService.OUT_OF_SCOPE_MESSAGE);
    expect(events.some(e => e.type === 'tool_status')).toBe(false);
  });
});

describe('Chat — remote AI client', () => {
  const saved = {};
  const realFetch = global.fetch;
  let agent;

  beforeAll(async () => {
    ENV_KEYS.forEach(k => { saved[k] = process.env[k]; });
    delete process.env.AI_CLIENT_MODE;
    process.env.AI_CLIENT_URL = 'https://ai-client.internal/v1/chat/turn';
    process.env.CHAT_INTERNAL_TOKEN_SECRET = 'test-secret';
    agent = await loggedInAgent();
  });
  afterEach(() => { global.fetch = realFetch; delete process.env.AI_CLIENT_TIMEOUT_MS; });
  afterAll(() => ENV_KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

  test('forwards the user context with a short-lived token and no portal credential', async () => {
    let captured;
    global.fetch = jest.fn(async (url, opts) => {
      captured = { url, opts };
      return new Response('event: completed\ndata: {"status":"success"}\n\n', { status: 200 });
    });
    const res = await turn(agent, 'Statut du déploiement de cnp-test-node', { environment: 'dev' });
    expect(res.status).toBe(200);

    const headers = captured.opts.headers;
    expect(Object.keys(headers).map(h => h.toLowerCase())).not.toContain('cookie');
    const [, payloadB64] = headers.Authorization.replace('Bearer ', '').split('.');
    const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'cnp-portal', aud: 'cnp-mcp', login: 'admin', role: 'cnp_reader', scopes: ['cnp:read'] });
    expect(claims.exp - claims.iat).toBe(300);

    const body = JSON.parse(captured.opts.body);
    expect(body.userRequest).toBe('Statut du déploiement de cnp-test-node');
    expect(body.knownContext.environment).toBe('dev');
    expect(JSON.stringify(body)).not.toMatch(/connect\.sid|session|password|token/i);
  });

  test('provider errors and unknown events are never exposed to the browser', async () => {
    global.fetch = jest.fn(async () => new Response(
      'event: debug\ndata: {"prompt":"system prompt"}\n\n' +
      'event: answer_delta\ndata: {"text":"Début de réponse"}\n\n' +
      'event: error\ndata: {"code":"TYPESAFE_PROVIDER_500","message":"TypeSafe upstream 500 at api.typesafe.internal"}\n\n',
      { status: 200 },
    ));
    const res = await turn(agent, 'liste les applications');
    expect(res.text).not.toMatch(/TypeSafe|typesafe|system prompt/);
    const events = parseEvents(res.text);
    expect(events.map(e => e.type)).toEqual(['answer_delta', 'error']);
    expect(events[1].data.code).toBe('INTERNAL_ERROR');
    expect(events[1].data.retryable).toBe(true);
  });

  test('an unreachable AI client yields a controlled unavailable state', async () => {
    global.fetch = jest.fn(async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443'); });
    const res = await turn(agent, 'liste les applications');
    const error = parseEvents(res.text).find(e => e.type === 'error');
    expect(error.data.category).toBe('unavailable');
    expect(res.text).not.toContain('ECONNREFUSED');
  });

  test('a slow AI client yields a timeout state', async () => {
    process.env.AI_CLIENT_TIMEOUT_MS = '50';
    global.fetch = jest.fn((url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const res = await turn(agent, 'liste les applications');
    const error = parseEvents(res.text).find(e => e.type === 'error');
    expect(error.data.code).toBe('TIMEOUT');
    expect(error.data.category).toBe('timeout');
  });

  test('a 403 from the AI client yields the forbidden state', async () => {
    global.fetch = jest.fn(async () => new Response('denied', { status: 403 }));
    const res = await turn(agent, 'liste les applications');
    expect(parseEvents(res.text).find(e => e.type === 'error').data.category).toBe('forbidden');
  });
});

describe('Chat service', () => {
  test('KnownContext only keeps registered applications and known environments', () => {
    const ctx = chatService.buildKnownContext(
      { message: 'logs', context: { applicationId: 'unknown-app', environment: 'staging' } },
      ['cnp-test-node'],
    );
    expect(ctx).toEqual({});
    expect(chatService.buildKnownContext({ message: 'logs de cnp-test-node en prod', context: {} }, ['cnp-test-node']))
      .toEqual({ applicationId: 'cnp-test-node', environment: 'prod' });
  });

  test('internal token cannot be issued without a secret', () => {
    expect(() => chatService.issueInternalToken({ id: 'u1', username: 'a' }, '')).toThrow();
  });
});
