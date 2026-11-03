'use strict';

const { inputSchemas, responseSchemas, toolNames } = require('../../../../packages/contracts/src');

class HttpMcpClient {
  constructor({ url, token, tokenProvider, origin, local = false, timeoutMs = 10000 }) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/mcp') {
      throw new Error('INVALID_MCP_URL');
    }
    if (parsed.protocol !== 'https:' && !(local && process.env.NODE_ENV !== 'production'
      && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) {
      throw new Error('TLS_REQUIRED');
    }
    if (!tokenProvider && (!token || /[\r\n]/.test(token))) throw new Error('MCP_TOKEN_REQUIRED');
    if (new URL(origin).origin !== origin) throw new Error('INVALID_MCP_ORIGIN');
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS_CERTIFICATE_INVALID');
    this.options = { url: parsed, token, tokenProvider, origin, timeoutMs };
  }

  async callTool(tool, args, { correlationId }) {
    if (!toolNames.includes(tool)) throw new Error('TOOL_UNAVAILABLE');
    const validated = inputSchemas[tool].parse(args);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'cnp-portal', version: '1.0.0' });
    const { url, origin, timeoutMs } = this.options;
    const token = this.options.tokenProvider ? this.options.tokenProvider() : this.options.token;
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}`, Origin: origin }, redirect: 'error' },
    });
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      await client.connect(transport, { signal, timeout: timeoutMs });
      const available = await client.listTools({}, { signal, timeout: timeoutMs });
      if (!available.tools.some((item) => item.name === tool)) throw new Error('TOOL_UNAVAILABLE');
      const result = await client.callTool({ name: tool, arguments: validated, _meta: { correlationId } },
        undefined, { signal, timeout: timeoutMs });
      const content = result.structuredContent || JSON.parse(result.content.find((item) => item.type === 'text').text);
      const response = responseSchemas[tool].parse(content);
      if (response.meta.correlationId !== correlationId) throw new Error('INVALID_MCP_RESPONSE');
      return response;
    } catch (error) {
      const status = error.code;
      const cause = error.cause && error.cause.code;
      const code = status === 401 ? 'MCP_UNAUTHENTICATED'
        : status === 403 ? 'MCP_FORBIDDEN'
          : status === 404 || status === 405 ? 'MCP_ENDPOINT_INVALID'
            : cause === 'ECONNREFUSED' ? 'MCP_UNREACHABLE'
              : error.name === 'TimeoutError' || error.name === 'AbortError' ? 'MCP_TIMEOUT'
                : error.name === 'ZodError' ? 'INVALID_MCP_RESPONSE' : 'MCP_CONNECTION_FAILED';
      const issue = new Error(code);
      issue.code = code;
      throw issue;
    } finally {
      await client.close();
    }
  }
}

module.exports = { HttpMcpClient };
