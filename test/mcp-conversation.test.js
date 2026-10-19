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

test('deployment asks for app/env and resumes the same tool across three messages', async () => {
  const resolve = jest.fn(async () => 'app-2-dancingduck');
  const chat = conversation(resolve);
  expect((await chat.turn('/deploiment')).at(-1).type).toBe('clarification_required');
  expect(resolve).not.toHaveBeenCalled();
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
  const response = await chat.turn('l’application sur le canard');
  expect(response.at(-1)).toMatchObject({ type: 'clarification_required', question: expect.stringMatching(/environnement/i) });
  expect(resolve.mock.calls[0][0].applications.map(app => app.applicationId)).toEqual(['app-2-dancingduck']);
  await chat.turn('en prod');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_deployment_status', {
    applicationId: 'app-2-dancingduck', environment: 'prod',
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
  await chat.turn('/deploiement');
  const response = await chat.turn('le canard en dev');
  expect(response.at(-1).type).toBe('clarification_required');
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
});

test('mutation in a clarification reply is refused before semantic resolution', async () => {
  const resolve = jest.fn();
  const chat = conversation(resolve);
  await chat.turn('/deploiement');
  expect((await chat.turn('supprime app-2-dancingduck')).at(-1)).toMatchObject({ code: 'FORBIDDEN' });
  expect(resolve).not.toHaveBeenCalled();
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
});

test('an AI outage asks again and an exact reply can still complete the request', async () => {
  const chat = conversation(async () => { throw new Error('AI unavailable'); });
  await chat.turn('/deploiement');
  expect((await chat.turn('le canard')).at(-1).type).toBe('clarification_required');
  expect(chat.mcpClient.callTool).not.toHaveBeenCalled();
  await chat.turn('app-2-dancingduck en dev');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_deployment_status', expect.any(Object), expect.any(Object));
});

test('an environment-only reply never asks AI to guess an application', async () => {
  const resolve = jest.fn(async () => 'app-2-dancingduck');
  const chat = conversation(resolve);
  await chat.turn('/deploiement');
  expect((await chat.turn('en dev')).at(-1).question).toMatch(/application/i);
  expect(resolve).not.toHaveBeenCalled();
  await chat.turn('app-2-dancingduck');
  expect(chat.mcpClient.callTool).toHaveBeenCalledWith('get_deployment_status', {
    applicationId: 'app-2-dancingduck', environment: 'dev',
  }, expect.any(Object));
});

test('cancel clears the pending tool', async () => {
  const chat = conversation();
  await chat.turn('/deploiement');
  expect((await chat.turn('/annuler')).at(-1).type).toBe('turn_completed');
  await chat.turn('app-2-dancingduck en dev');
  expect(chat.mcpClient.callTool.mock.calls.some(([tool]) => tool === 'get_deployment_status')).toBe(false);
});

test('an explicit new command replaces a pending deployment request', async () => {
  const chat = conversation();
  await chat.turn('/deploiement');
  await chat.turn('/applications');
  expect(chat.mcpClient.callTool.mock.calls.map(([tool]) => tool)).toEqual(['list_applications']);
});
