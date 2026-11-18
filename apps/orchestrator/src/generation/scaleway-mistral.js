'use strict';

const DEFAULT_GATEWAY = 'https://api.scaleway.ai/53dabd61-d11a-46f3-be72-1a992593284f/v1';
const DEFAULT_MODEL = 'mistral-small-3.2-24b-instruct-2506';

function config(env) {
  const key = env.REPORT_MODEL_API_KEY?.trim();
  const model = (env.MCP_MISTRAL_MODEL || env.VOICE_DEPLOYMENT_ANALYSIS_MODEL || DEFAULT_MODEL).trim();
  const project = env.SCW_DEFAULT_PROJECT_ID?.trim();
  const base = new URL(env.VOICE_DEPLOYMENT_GATEWAY_BASE_URL || DEFAULT_GATEWAY);
  if (!key || /[\r\n]/.test(key) || !/^mistral-[a-z0-9.-]+$/i.test(model) ||
      base.origin !== 'https://api.scaleway.ai' || base.username || base.password || base.search || base.hash ||
      !/^\/(?:[a-f0-9-]{36}\/)?v1\/?$/i.test(base.pathname) ||
      (project && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(project))) {
    throw new Error('GENAI_NOT_CONFIGURED');
  }
  return { key, model, base: project ? `${base.origin}/${project}/v1` : base.href.replace(/\/$/, '') };
}

async function complete({ env = process.env, fetch: transport = globalThis.fetch, system, prompt, maxTokens = 800, schema, timeoutMs = 15000 }) {
  const { key, model, base } = config(env);
  const response = await transport(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens,
      ...(schema ? { response_format: { type: 'json_schema', json_schema: schema } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
  });
  if (!response.ok) throw new Error('GENAI_UNAVAILABLE');
  const payload = await response.json();
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === 'length' || typeof choice?.message?.content !== 'string' || !choice.message.content.trim()) {
    throw new Error('GENAI_INVALID_RESPONSE');
  }
  return choice.message.content.trim();
}

module.exports = { complete, config };
