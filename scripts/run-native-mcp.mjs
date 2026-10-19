import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const root = resolve(process.env.MCP_PROJECT_DIR || '../MCP-CNP');
const load = (file) => import(pathToFileURL(resolve(root, 'dist/apps/mcp-server/src', file)).href);
const { createHttpServer } = await load('http.js');
const { SourceError } = await load('adapters.js');
const { createNativeAdapters } = require('../apps/orchestrator/src/sources/native-adapters.cjs');
if (process.env.NODE_ENV === 'production') throw new Error('Native local launcher requires development mode.');
const secret = process.env.MCP_JWT_SECRET;
if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Invalid local signing configuration');
const server = createHttpServer({ auth: { secret: new TextEncoder().encode(secret) }, adapters: createNativeAdapters({ SourceError }),
  allowedHosts: ['127.0.0.1', 'localhost'], origins: ['http://localhost:3001'],
  audit: (record) => process.stderr.write(JSON.stringify(record) + '\n') });
await server.listen({ host: '127.0.0.1', port: 3000 });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close().then(() => process.exit(0)); });
