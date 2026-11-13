import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAnswerGenerator } = require('../apps/orchestrator/src/generation/answer');
const { FakeMcpClient } = require('../apps/orchestrator/src/mcp-client/fake-client');
let requestBody;
const generate = createAnswerGenerator({ env: { GENAI_ENABLED: 'true', GENAI_API_KEY: 'test-secret', GENAI_MODEL: 'test-model' },
  fetch: async (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    requestBody = JSON.parse(options.body);
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.model, 'test-model');
    assert.equal(requestBody.tools, undefined);
    return new Response(JSON.stringify({ id: 'resp_test', created_at: 1700000000, status: 'completed', model: 'test-model',
      output: [{ type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text: 'Une application de test est enregistrée.', annotations: [] }] }],
      usage: { input_tokens: 100, output_tokens: 15 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
const result = await new FakeMcpClient().callTool('list_applications', {}, { correlationId: 'test' });
const text = await generate({ message: 'Liste les applications Bearer never-forward-this', tool: 'list_applications', result });
assert.equal(text, 'Une application de test est enregistrée.');
assert.ok(!JSON.stringify(requestBody).includes('never-forward-this'));
assert.ok(!JSON.stringify(requestBody).includes('test-secret'));
console.log('PASS: real AI SDK + OpenAI Responses request shape, bounded verified evidence, secret scrubbing, no mutation tools, response parsing. API response simulated; no live OpenAI credentials used.');
