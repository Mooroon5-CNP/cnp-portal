'use strict';

const { runChatTurn } = require('../apps/orchestrator/src/chat/service');
const { FakeMcpClient } = require('../apps/orchestrator/src/mcp-client/fake-client');
const { assertSecureMcpUrl } = require('../apps/orchestrator/src/mcp-client');
const { classifyWithFallback } = require('../apps/orchestrator/src/typesafe/fallback-classifier');
const { FixtureCatalog } = require('../apps/orchestrator/src/catalog/fixture-catalog');
const { createKnownContextBuilder } = require('../apps/orchestrator/src/context/known-context-builder');

async function collect(request) {
  const events = [];
  for await (const event of runChatTurn(request, {
    mcpClient: new FakeMcpClient(),
    classify: classifyWithFallback,
    buildKnownContext: createKnownContextBuilder(new FixtureCatalog()),
    actor: { userId: 'test-user', roles: ['dev'], authenticated: true },
    now: () => new Date('2026-01-01T12:00:00.000Z'),
  })) events.push(event);
  return events;
}

describe('MCP orchestrator', () => {
  test('sends only validated minimal context to the classifier', async () => {
    const classify = jest.fn(() => ({ kind: 'clarification' }));
    const events = [];
    for await (const event of runChatTurn({
      message: 'Montre les logs de cette application',
      context: { applicationId: 'majoutes-api', environment: 'dev' },
    }, {
      mcpClient: new FakeMcpClient(),
      classify,
      buildKnownContext: createKnownContextBuilder(new FixtureCatalog()),
      actor: { userId: 'test-user', roles: ['dev'], authenticated: true },
      now: () => new Date('2026-01-01T12:00:00.000Z'),
    })) events.push(event);

    expect(classify).toHaveBeenCalledWith({
      userRequest: 'Montre les logs de cette application',
      availableReadOnlyTools: [
        'list_applications', 'get_deployment_status',
        'get_application_logs', 'get_finops_recommendation',
      ],
      knownContext: {
        schemaVersion: '1.0',
        actor: { userId: 'test-user', roles: ['dev'], authenticated: true },
        navigation: { openPage: 'unknown' },
        target: { applicationId: 'majoutes-api', environment: 'development' },
        view: {},
        permissions: {
          allowedTools: [
            'list_applications', 'get_deployment_status',
            'get_application_logs', 'get_finops_recommendation',
          ],
        },
        conversation: {},
        locale: { language: 'fr', timezone: 'Europe/Paris' },
      },
    });
    expect(JSON.stringify(classify.mock.calls[0][0])).not.toMatch(/token|cookie|secret/i);
    expect(events.at(-1).type).toBe('clarification_required');
  });

  test('streams a grounded application list with sources', async () => {
    const events = await collect({ message: 'Liste les applications disponibles' });
    expect(events.map((event) => event.type)).toEqual([
      'turn_started', 'tool_started', 'tool_completed', 'answer_delta', 'turn_completed',
    ]);
    expect(events[1].tool).toBe('list_applications');
    expect(events[3].text).toContain('Majoutes API');
    expect(events[4].sources[0].source).toBe('platform_api_fixture');
  });

  test('refuses mutations before calling MCP', async () => {
    const events = await collect({ message: 'Deploy majoutes-api in prod' });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'error', code: 'FORBIDDEN', retryable: false });
  });

  test('asks for target context when required', async () => {
    const events = await collect({ message: 'Show deployment status' });
    expect(events[1].type).toBe('clarification_required');
  });

  test('keeps FinOps monetary values absent and exposes warning', async () => {
    const events = await collect({ message: 'FinOps for majoutes-api in dev' });
    expect(events.some((event) => event.type === 'warning' && event.code === 'FINOPS_COST_DATA_UNAVAILABLE')).toBe(true);
    expect(events.find((event) => event.type === 'answer_delta').text).toContain('indisponibles');
  });

  test('rejects remote clear-text MCP endpoints', () => {
    expect(() => assertSecureMcpUrl('http://mcp.example.test/mcp', 'production')).toThrow('HTTPS');
    expect(() => assertSecureMcpUrl('http://127.0.0.1:3001/mcp', 'development')).not.toThrow();
  });
});
