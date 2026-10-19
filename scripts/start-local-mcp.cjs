'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { randomBytes, randomUUID } = require('crypto');
const { createMcpClient } = require('../apps/orchestrator/src/mcp-client');

const portalRoot = path.resolve(__dirname, '..');
const mcpRoot = path.resolve(process.env.MCP_PROJECT_DIR || path.join(portalRoot, '../MCP-CNP'));
const readEnv = (root) => fs.existsSync(path.join(root, '.env'))
  ? dotenv.parse(fs.readFileSync(path.join(root, '.env'))) : {};
const mock = process.argv.includes('--mock');
const secret = readEnv(mcpRoot).MCP_JWT_SECRET || randomBytes(32).toString('hex');
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
function start(root, script, env, args = []) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: 'inherit' });
  children.push(child);
  child.on('error', () => { console.error('Unable to start local service. Check Node and the sibling MCP-CNP checkout.'); stop(1); });
  child.on('exit', (code) => { if (!stopping) stop(code || 1); });
  return child;
}
async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Use this launcher only for local development.');
  // Detect occupied ports before starting either service; never terminate somebody else's process.
  const net = require('net');
  for (const port of [3000, 3001]) {
    await new Promise((accept, reject) => {
      const socket = net.createServer();
      socket.once('error', () => reject(new Error(`Port ${port} is occupied. Stop the old local service first.`)));
      socket.listen(port, '127.0.0.1', () => socket.close(accept));
    });
  }
  const entry = path.join(mcpRoot, 'dist/apps/mcp-server/src/index.js');
  if (!fs.existsSync(entry)) throw new Error('Build MCP-CNP first: cd ../MCP-CNP && npm run build');
  const mcpEnv = { ...process.env, ...readEnv(mcpRoot), ...readEnv(portalRoot), MCP_PROJECT_DIR: mcpRoot, NODE_ENV: 'development',
    PORT: '3000', ADAPTER_MODE: 'mock', MCP_JWT_SECRET: secret,
    MCP_ALLOWED_HOSTS: '127.0.0.1,localhost', MCP_ALLOWED_ORIGINS: 'http://localhost:3001',
    MCP_TLS_KEY_FILE: '', MCP_TLS_CERT_FILE: '' };
  const portalEnv = { ...process.env, ...Object.fromEntries(Object.entries(readEnv(mcpRoot)).filter(([key]) => key.startsWith('TYPESAFE_'))), ...readEnv(portalRoot), MCP_PROJECT_DIR: mcpRoot, MCP_DATA_MODE: mock ? 'mock' : 'real', MCP_ROUTING_MODE: process.env.MCP_ROUTING_MODE || readEnv(portalRoot).MCP_ROUTING_MODE || 'hybrid', NODE_ENV: 'development', PORT: '3001',
    MCP_CLIENT_MODE: 'http', MCP_URL: 'http://127.0.0.1:3000/mcp',
    MCP_ORIGIN: 'http://localhost:3001', MCP_LOCAL_HTTP: 'true', MCP_LOCAL_JWT_SECRET: secret };
  if (mock) start(mcpRoot, entry, mcpEnv, ['--http']);
  else start(portalRoot, path.join(portalRoot, 'scripts/run-native-mcp.mjs'), mcpEnv);
  let ready = false;
  for (let attempt = 0; attempt < 50 && !stopping; attempt++) {
    try { ready = (await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(500) })).ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise((accept) => setTimeout(accept, 100));
  }
  if (!ready) throw new Error('MCP failed to start; check the startup message above.');
  const result = await createMcpClient(portalEnv).callTool('list_applications', { limit: 20 }, { correlationId: randomUUID() });
  if (result.status === 'error') throw new Error('MCP catalog probe failed.');
  console.log('MCP authenticated catalog probe passed. Local five-minute JWTs refresh on each call.');
  start(portalRoot, path.join(portalRoot, 'src/index.js'), portalEnv);
  console.log('Open http://localhost:3001/mcp-chat and sign in. MCP: http://127.0.0.1:3000/mcp');
  console.log(mock ? 'Explicit mock mode.' : 'Real source mode: Git registry, Argo, Kubernetes, Datadog; no mock fallback.');
  console.log('Routing: confident local matches, otherwise Jev. GenAI uses GENAI_* configuration. Ctrl+C stops both services.');
}
main().catch((error) => { console.error(error.message); stop(1); });
