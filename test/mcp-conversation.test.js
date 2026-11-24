'use strict';

const { runChatTurn } = require('../apps/orchestrator/src/chat/service');
const { createKnownContextBuilder } = require('../apps/orchestrator/src/context/known-context-builder');
const { classifyWithFallback } = require('../apps/orchestrator/src/typesafe/fallback-classifier');
const { FakeMcpClient } = require('../apps/orchestrator/src/mcp-client/fake-client');

const applications = [{ applicationId: 'app-2-dancingduck', name: 'Dancing Duck',
  environments: [{ name: 'dev', enabled: true }, { name: 'prod', enabled: true }] }];

function conversation(resolveApplication) {
  let pendingRequest;
  const fake = new FakeMcpClient();
  const mcpClient = { callTool: jest.fn((tool, args, meta) => fake.callTool(tool, args, meta)) };
  const buildKnownContext = createKnownContextBuilder({ listApplications: async () => applications }, { resolveApplication });
  let conversationId;
  return { mcpClient, async turn(message) {
    const events = [];
    for await (const event of runChatTurn({ message, ...(conversationId ? { conversationId } : {}) }, {
      mcpClient, buildKnownContext, classify: classifyWithFallback,
      actor: { userId: 'user', roles: ['dev'], authenticated: true }, now: () => new Date(),
      pendingRequest, registerClarification: async record => { pendingRequest = record; },
      clearClarification: async () => { pendingRequest = undefined; },
    })) events.push(event);
    conversationId = events[0].conversationId;
    return events;
  } };
}

test('FinOps asks for app/env and resumes the same tool across three messages', async () => {
  const resolve = jest.fn(async () => 'app-2-dancingduck');
  const chat = conversation(resolve);
  expect((await chat.turn('/finops')).at(-1).type).toBe('clarification_required');
  expect(resolve).not.toHaveBeenCalled();
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
  const response = await chat.turn('l’application sur le canard');
  expect(response.at(-1)).toMatchObject({ type: 'clarification_required', question: expect.stringMatching(/environnement/i) });
  expect(resolve.mock.calls[0][0].applications.map(app => app.applicationId)).toEqual(['app-2-dancingduck']);
  await chat.turn('en prod');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_finops_recommendation', {
    applicationId: 'app-2-dancingduck', environment: 'prod', observationWindowDays: 14,
  }, expect.any(Object));
});

test('an exact application and environment resume a pending FinOps request without AI', async () => {
  const chat = conversation();
  await chat.turn('/finops');
  await chat.turn('app-2-dancingduck en dev');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_finops_recommendation', {
    applicationId: 'app-2-dancingduck', environment: 'dev', observationWindowDays: 14,
  }, expect.any(Object));
});

test('model suggestions cannot name an application outside the authorized catalog', async () => {
  const chat = conversation(async () => 'another-team-private-app');
  await chat.turn('/finops');
  const response = await chat.turn('le canard en dev');
  expect(response.at(-1).type).toBe('clarification_required');
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
});

test('mutation in a clarification reply is refused before semantic resolution', async () => {
  const resolve = jest.fn();
  const chat = conversation(resolve);
  await chat.turn('/finops');
  expect((await chat.turn('supprime app-2-dancingduck')).at(-1)).toMatchObject({ code: 'FORBIDDEN' });
  expect(resolve).not.toHaveBeenCalled();
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
});

test('an AI outage asks again and an exact reply can still complete the request', async () => {
  const chat = conversation(async () => { throw new Error('AI unavailable'); });
  await chat.turn('/finops');
  expect((await chat.turn('le canard')).at(-1).type).toBe('clarification_required');
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
  await chat.turn('app-2-dancingduck en dev');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_finops_recommendation', expect.any(Object), expect.any(Object));
});

test('an environment-only reply never asks AI to guess an application', async () => {
  const resolve = jest.fn(async () => 'app-2-dancingduck');
  const chat = conversation(resolve);
  await chat.turn('/finops');
  expect((await chat.turn('en dev')).at(-1).question).toMatch(/application/i);
  expect(resolve).not.toHaveBeenCalled();
  await chat.turn('app-2-dancingduck');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_finops_recommendation', {
    applicationId: 'app-2-dancingduck', environment: 'dev', observationWindowDays: 14,
  }, expect.any(Object));
});

test('cancel clears the pending tool', async () => {
  const chat = conversation();
  await chat.turn('/finops');
  expect((await chat.turn('/annuler')).at(-1).type).toBe('turn_completed');
  await chat.turn('app-2-dancingduck en dev');
  expect(chat.mcpClient.callTool.mock.calls.some(([tool]) => tool === 'get_finops_recommendation')).toBe(false);
});

test('an explicit new command replaces a pending FinOps request', async () => {
  const chat = conversation();
  await chat.turn('/finops');
  await chat.turn('/applications');
  expect(chat.mcpClient.callTool.mock.calls.map(([tool]) => tool)).toEqual(['list_applications']);
});

test('/deploiement without an application reports every accessible environment instead of asking', async () => {
  const chat = conversation();
  const events = await chat.turn('/deploiement');
  const tools = chat.mcpClient.callTool.mock.calls.map(([tool]) => tool);
  expect(tools[0]).toBe('list_applications');
  expect(tools.filter(tool => tool === 'get_deployment_status').length).toBeGreaterThan(0);
  expect(events.some(event => event.type === 'clarification_required')).toBe(false);
  expect(events.find(event => event.type === 'answer_delta').text).toMatch(/État des déploiements|synchronisé/);
  expect(events.at(-1).type).toBe('turn_completed');
});

test('/logs without an application reads recent errors and warnings of every environment', async () => {
  const chat = conversation();
  const events = await chat.turn('/logs');
  const calls = chat.mcpClient.callTool.mock.calls.filter(([tool]) => tool === 'get_application_logs');
  expect(calls.length).toBeGreaterThan(0);
  for (const [, args] of calls) expect(args).toMatchObject({ levels: ['ERROR', 'WARN'], limit: 20 });
  expect(events.some(event => event.type === 'clarification_required')).toBe(false);
  expect(events.at(-1).type).toBe('turn_completed');
});

test('/applications non sync lists only the problems (or says everything is fine)', async () => {
  const chat = conversation();
  const events = await chat.turn('/applications non sync');
  expect(chat.mcpClient.callTool.mock.calls.map(([tool]) => tool)).toContain('get_deployment_status');
  const text = events.find(event => event.type === 'answer_delta').text;
  expect(text).toMatch(/désynchronisé|Tout est synchronisé/);
});

test('a greeting gets examples, without calling any tool', async () => {
  const chat = conversation();
  const events = await chat.turn('Bonjour');
  expect(events.find(event => event.type === 'answer_delta').text).toMatch(/lecture seule[\s\S]*désynchronisées/);
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
});
