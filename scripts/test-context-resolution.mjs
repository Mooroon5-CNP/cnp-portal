import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createApplicationResolver } = require('../apps/orchestrator/src/generation/application');
let body;
const resolve = createApplicationResolver({
  env: { REPORT_MODEL_API_KEY: 'test-key-not-live', MCP_MISTRAL_MODEL: 'mistral-test-model' },
  fetch: async (url, options) => {
    assert.equal(String(url), 'https://api.scaleway.ai/53dabd61-d11a-46f3-be72-1a992593284f/v1/chat/completions');
    body = JSON.parse(options.body);
    assert.equal(body.response_format.type, 'json_schema');
    assert.equal(body.tools, undefined);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
      content: JSON.stringify({ applicationId: 'app-2-dancingduck', confidence: 'high' }),
    } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});
assert.equal(await resolve({ message: 'l’application du canard Bearer must-not-forward',
  applications: [{ applicationId: 'app-2-dancingduck', name: 'Dancing Duck', token: 'private-metadata' }],
}), 'app-2-dancingduck');
assert.ok(!JSON.stringify(body).includes('must-not-forward'));
assert.ok(!JSON.stringify(body).includes('private-metadata'));
assert.ok(!JSON.stringify(body).includes('test-key-not-live'));
console.log('PASS: Scaleway Mistral structured chat completion, authorized catalog only, no secret forwarding. Response simulated.');
