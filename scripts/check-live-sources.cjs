'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const dotenv = require('dotenv');
Object.assign(process.env, dotenv.parse(fs.readFileSync(path.join(__dirname, '../.env'))));
const mcpRoot = path.resolve(process.env.MCP_PROJECT_DIR || path.join(__dirname, '../../MCP-CNP'));
const mcpEnvPath = path.join(mcpRoot, '.env');
if (fs.existsSync(mcpEnvPath)) {
  for (const [key, value] of Object.entries(dotenv.parse(fs.readFileSync(mcpEnvPath)))) {
    if (key.startsWith('TYPESAFE_') && process.env[key] === undefined) process.env[key] = value;
  }
}
(async () => {
  const { SourceError } = await import(pathToFileURL(path.join(mcpRoot, 'dist/apps/mcp-server/src/adapters.js')).href);
  const { executeTool } = await import(pathToFileURL(path.join(mcpRoot, 'dist/apps/mcp-server/src/tools.js')).href);
  const { createNativeAdapters } = require('../apps/orchestrator/src/sources/native-adapters.cjs');
  const adapters = createNativeAdapters({ SourceError });
  const catalog = await executeTool('list_applications', { limit: 100 }, adapters);
  console.log('Catalog:', catalog.status, catalog.data?.applications.map((entry) => entry.applicationId).join(', ') || 'unavailable');
  if (catalog.status === 'error') { process.exitCode = 1; return; }
  if (catalog.warnings.some((entry) => entry.code === 'MOCK_DATA')) throw new Error('Unexpected mock source');
  const applicationId = process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'app-2-dancingduck';
  for (const [tool, args] of [
    ['get_deployment_status', { applicationId, environment: 'dev' }],
    ['get_application_logs', { applicationId, environment: 'dev', from: new Date(Date.now() - 3600000).toISOString(), to: new Date().toISOString(), limit: 20 }],
    ['get_finops_recommendation', { applicationId, environment: 'dev' }],
  ]) {
    const result = await executeTool(tool, args, adapters);
    console.log(tool, result.status, 'warnings:', result.warnings.map((issue) => `${issue.source}:${issue.code}`).join(', '),
      'errors:', result.errors.map((issue) => `${issue.source}:${issue.code}`).join(', '));
    if (result.warnings.some((entry) => entry.code === 'MOCK_DATA')) throw new Error('Unexpected mock source');
  }
  if (process.argv.includes('--sources-only')) {
    console.log('Read-only source check complete; no Jev or generation API called.');
    return;
  }
  const { createHybridClassifier } = require('../apps/orchestrator/src/typesafe/hybrid-classifier');
  const decision = await createHybridClassifier({ env: { ...process.env, MCP_ROUTING_MODE: 'jev', MCP_PROJECT_DIR: mcpRoot } })({
    userRequest: 'Quelle version tourne actuellement ?', knownContext: { target: { applicationId, environment: 'development' },
      permissions: { allowedTools: ['list_applications', 'get_deployment_status', 'get_application_logs', 'get_finops_recommendation'] } },
  });
  console.log('Live Jev routing:', decision.kind, decision.tool || decision.reason || '');
  console.log('OpenAI generation configured:', process.env.GENAI_ENABLED === 'true' && Boolean(process.env.GENAI_API_KEY && process.env.GENAI_MODEL));
})().catch(() => { console.error('Source check failed; verify configuration and MCP build.'); process.exitCode = 1; });
