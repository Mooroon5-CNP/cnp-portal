import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createAnswerGenerator } = require('../apps/orchestrator/src/generation/answer');
const { FakeMcpClient } = require('../apps/orchestrator/src/mcp-client/fake-client');
let body;
const generate = createAnswerGenerator({ env: { REPORT_MODEL_API_KEY: 'test-secret', MCP_MISTRAL_MODEL: 'mistral-test-model' },
  fetch: async (url, options) => {
    assert.equal(String(url), 'https://api.scaleway.ai/53dabd61-d11a-46f3-be72-1a992593284f/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(options.redirect, 'error');
    body = JSON.parse(options.body);
    assert.equal(body.model, 'mistral-test-model');
    assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Une application de test est enregistrée.' } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  } });
const result = await new FakeMcpClient().callTool('list_applications', {}, { correlationId: 'test' });
const answer = await generate({ message: 'Liste les applications Bearer never-forward-this', tool: 'list_applications', result });
assert.equal(answer, 'Une application de test est enregistrée.');
assert.ok(!JSON.stringify(body).includes('never-forward-this'));
assert.ok(!JSON.stringify(body).includes('test-secret'));
console.log('PASS: Scaleway Mistral chat completion, bounded evidence, secret scrubbing and no mutation tools. Response simulated.');
