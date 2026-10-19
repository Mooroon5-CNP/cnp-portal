'use strict';

const { createHybridClassifier } = require('../apps/orchestrator/src/typesafe/hybrid-classifier');
const { runChatTurn } = require('../apps/orchestrator/src/chat/service');
const { resolveCommand } = require('../apps/orchestrator/src/commands');
const { createUserScope } = require('../apps/orchestrator/src/sources/user-scope');
const { FakeMcpClient } = require('../apps/orchestrator/src/mcp-client/fake-client');
const { createKnownContextBuilder } = require('../apps/orchestrator/src/context/known-context-builder');
const { FixtureCatalog } = require('../apps/orchestrator/src/catalog/fixture-catalog');
const { scrub } = require('../apps/orchestrator/src/generation/answer');

const context = { target: { applicationId: 'majoutes-api', environment: 'development' },
  permissions: { allowedTools: ['list_applications', 'get_application_logs'] }, actor: { token: 'never-forward-me' } };

test('local confident route bypasses Jev; unknown route invokes Jev with only minimal context', async () => {
  const decide = jest.fn(async () => ({ kind: 'route', tool: 'get_application_logs' }));
  const classify = createHybridClassifier({ env: { MCP_ROUTING_MODE: 'hybrid' }, decide });
  expect(await classify({ userRequest: 'liste les applications', knownContext: context })).toMatchObject({ tool: 'list_applications' });
  expect(decide).not.toHaveBeenCalled();
  expect(await classify({ userRequest: 'que se passe-t-il ?', knownContext: context })).toMatchObject({ tool: 'get_application_logs', routedBy: 'jev' });
  expect(decide.mock.calls[0][0]).toEqual({ userRequest: 'que se passe-t-il ?',
    availableReadOnlyTools: context.permissions.allowedTools, knownContext: { applicationId: 'majoutes-api', environment: 'dev' } });
  expect(JSON.stringify(decide.mock.calls)).not.toContain('never-forward-me');
});

test('mutation bypasses Jev and unavailable Jev does not execute the selected MCP tool', async () => {
  const decide = jest.fn(async () => ({ kind: 'routing_unavailable', reason: 'timeout' }));
  const classify = createHybridClassifier({ env: { MCP_ROUTING_MODE: 'hybrid' }, decide });
  expect(await classify({ userRequest: 'redémarrer le serveur', knownContext: context })).toMatchObject({ kind: 'mutation' });
  expect(decide).not.toHaveBeenCalled();
  const mcpClient = { callTool: jest.fn() }, events = [];
  for await (const event of runChatTurn({ message: 'que se passe-t-il ?' }, {
    classify, mcpClient, buildKnownContext: async () => context,
  })) events.push(event);
  expect(events.at(-1).code).toBe('ROUTING_UNAVAILABLE');
  expect(mcpClient.callTool).not.toHaveBeenCalled();
});

test('slash help does not contact a source or classifier and explicit commands resolve', async () => {
  expect(resolveCommand('/logs en prod')).toEqual({ tool: 'get_application_logs', message: 'Montre les logs en prod' });
  const classify = jest.fn(), buildKnownContext = jest.fn(), events = [];
  for await (const event of runChatTurn({ message: '/' }, { classify, buildKnownContext })) events.push(event);
  expect(events.find((event) => event.type === 'answer_delta').text).toContain('/finops');
  expect(buildKnownContext).not.toHaveBeenCalled();
  expect(classify).not.toHaveBeenCalled();
});

test('scoped catalog and tool response exclude another team and deny direct target', async () => {
  const app = (applicationId) => ({ applicationId });
  const client = { callTool: jest.fn(async () => ({ status: 'success', data: { applications: [app('mine'), app('other')], nextCursor: null } })) };
  const catalog = { listApplications: async () => [app('mine'), app('other')] };
  const scope = createUserScope(client, catalog, { listForUser: () => [{ app_name: 'mine' }] })({ id: 'user', role: 'dev' });
  expect(await scope.catalog.listApplications()).toEqual([app('mine')]);
  expect((await scope.mcpClient.callTool('list_applications', {}, {})).data.applications).toEqual([app('mine')]);
  await expect(scope.mcpClient.callTool('get_application_logs', { applicationId: 'other' }, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('generation receives validated tool evidence; failure leaves a truthful answer and warning', async () => {
  const generateAnswer = jest.fn(async ({ result }) => {
    expect(result.meta.tool).toBe('list_applications');
    throw new Error('unavailable');
  });
  const events = [];
  for await (const event of runChatTurn({ message: '/applications' }, {
    mcpClient: new FakeMcpClient(), classify: jest.fn(), generateAnswer,
    buildKnownContext: createKnownContextBuilder(new FixtureCatalog()),
    actor: { userId: 'user', roles: ['manager'], authenticated: true }, now: () => new Date(),
  })) events.push(event);
  expect(generateAnswer).toHaveBeenCalledTimes(1);
  expect(events.some((event) => event.code === 'GENERATION_UNAVAILABLE')).toBe(true);
  expect(events.find((event) => event.type === 'answer_delta').text).toContain('Majoutes API');
  expect(scrub('Bearer secret-token password=abc')).not.toMatch(/secret-token|abc/);
});

test('chat exposes authorized structured results even when answer generation is unavailable', async () => {
  const events = [];
  for await (const event of runChatTurn({ message: '/applications' }, {
    mcpClient: new FakeMcpClient(), classify: jest.fn(),
    buildKnownContext: createKnownContextBuilder(new FixtureCatalog()),
    actor: { userId: 'user', roles: ['manager'], authenticated: true }, now: () => new Date(),
  })) events.push(event);
  expect(events.find(event => event.type === 'tool_result')).toMatchObject({
    result: { tool: 'list_applications', data: { applications: expect.any(Array) } },
  });
});
