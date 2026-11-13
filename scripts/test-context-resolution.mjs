import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createApplicationResolver } = require('../apps/orchestrator/src/generation/application');
let body;
const resolve = createApplicationResolver({
  env: { GENAI_ENABLED: 'true', GENAI_API_KEY: 'test-key-not-live', GENAI_MODEL: 'test-model' },
  fetch: async (url, options) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ id: 'resp_context', created_at: 1700000000, status: 'completed', model: 'test-model',
      output: [{ type: 'message', id: 'msg_context', role: 'assistant', content: [{ type: 'output_text',
        text: JSON.stringify({ applicationId: 'app-2-dancingduck', confidence: 'high' }), annotations: [] }] }],
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(await resolve({ message: 'l’application du canard Bearer must-not-forward',
  applications: [{ applicationId: 'app-2-dancingduck', name: 'Dancing Duck', token: 'private-metadata' }],
}), 'app-2-dancingduck');
assert.ok(!JSON.stringify(body).includes('must-not-forward'));
assert.ok(!JSON.stringify(body).includes('private-metadata'));
assert.ok(!JSON.stringify(body).includes('test-key-not-live'));
console.log('PASS: real AI SDK structured Responses request, authorized catalog only, no tools, no secret forwarding. Model response simulated; no paid API call.');
