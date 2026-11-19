'use strict';

const { decideWithMistral } = require('../apps/orchestrator/src/typesafe/mistral-classifier');
const { createAnswerGenerator } = require('../apps/orchestrator/src/generation/answer');

const env = { REPORT_MODEL_API_KEY: 'test-key', VOICE_DEPLOYMENT_ANALYSIS_MODEL: 'mistral-small-3.2-24b-instruct-2506' };
const input = { userRequest: 'que se passe-t-il Bearer private-token ?',
  availableReadOnlyTools: ['get_application_logs'], knownContext: { applicationId: 'my-app', environment: 'dev' } };

test('Mistral routing sends minimal context and accepts only an authorized confident read', async () => {
  let body;
  const fetch = jest.fn(async (url, options) => {
    expect(String(url)).toBe('https://api.scaleway.ai/53dabd61-d11a-46f3-be72-1a992593284f/v1/chat/completions');
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ tool: 'get_application_logs', confidence: 0.95, impact: 'read_only' }),
    } }] }), { status: 200 });
  });
  await expect(decideWithMistral(input, { env, fetch })).resolves.toEqual({ kind: 'route', tool: 'get_application_logs' });
  expect(body.model).toMatch(/^mistral-/);
  expect(body.tools).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain('private-token');
  expect(JSON.stringify(body)).not.toContain('test-key');
});

test.each([
  [{ tool: 'get_deployment_status', confidence: 0.99, impact: 'read_only' }, { kind: 'rejected', reason: 'unsupported' }],
  [{ tool: 'get_application_logs', confidence: 0.6, impact: 'read_only' }, { kind: 'clarification_required' }],
  [{ tool: 'get_application_logs', confidence: 0.99, impact: 'mutation' }, { kind: 'rejected', reason: 'mutation' }],
])('Mistral cannot bypass tool, confidence or impact limits', async (answer, expected) => {
  const fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(answer) } }] }), { status: 200 });
  await expect(decideWithMistral(input, { env, fetch })).resolves.toEqual(expected);
});

test('MCP refuses a non-Mistral model before sending an AI request', async () => {
  const fetch = jest.fn();
  const generate = createAnswerGenerator({ env: { ...env, MCP_MISTRAL_MODEL: 'gpt-test' }, fetch });
  await expect(generate({ message: 'test', tool: 'list_applications', result: {
    status: 'success', data: {}, warnings: [], meta: { sources: [] },
  } })).rejects.toThrow('GENAI_NOT_CONFIGURED');
  expect(fetch).not.toHaveBeenCalled();
});
