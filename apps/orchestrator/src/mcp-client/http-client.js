'use strict';

const {
  inputSchemas, responseSchemas, toolNames, gcpCloudAssistToolName, gcpCloudAssistInputSchema, gcpCloudAssistResponseSchema,
} = require('../../../../packages/contracts/src');

const schemasFor = (tool) => (tool === gcpCloudAssistToolName
  ? { input: gcpCloudAssistInputSchema, response: gcpCloudAssistResponseSchema }
  : toolNames.includes(tool) ? { input: inputSchemas[tool], response: responseSchemas[tool] } : undefined);

const METADATA_IDENTITY = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

class HttpMcpClient {
  constructor({ url, token, tokenProvider, origin, local = false, timeoutMs = 10000, gcaTimeoutMs = 60000, iamAudience, fetch: customFetch }) {
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
    if (iamAudience && new URL(iamAudience).protocol !== 'https:') throw new Error('INVALID_MCP_IAM_AUDIENCE');
    this.options = { url: parsed, token, tokenProvider, origin, timeoutMs, gcaTimeoutMs, iamAudience, fetch: customFetch || fetch };
    this.identity = undefined;
  }

  /** Cloud Run IAM: Google ID token of the portal workload identity, sent in X-Serverless-Authorization. */
  async identityToken() {
    const now = Date.now();
    if (this.identity && this.identity.expiresAt - 60_000 > now) return this.identity.token;
    const url = `${METADATA_IDENTITY}?audience=${encodeURIComponent(this.options.iamAudience)}&format=full`;
    const response = await this.options.fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) });
    const token = response.ok ? (await response.text()).trim() : '';
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error('MCP_IAM_TOKEN_UNAVAILABLE');
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    this.identity = { token, expiresAt: Number(exp) * 1000 };
    return token;
  }

  /**
   * `actor` identifies the portal user; `authorizedTarget` is set only by the user scope after it checked
   * the application and environment. Both become signed claims; nothing else is trusted by the MCP.
   */
  async callTool(tool, args, { correlationId, actor, authorizedTarget } = {}) {
    const schemas = schemasFor(tool);
    if (!schemas) throw new Error('TOOL_UNAVAILABLE');
    const validated = schemas.input.parse(args);
    const claims = {
      ...(actor ? { sub: actor.userId, role: actor.roles[0] } : {}),
      ...(authorizedTarget ? { app: authorizedTarget.applicationId, env: authorizedTarget.environment } : {}),
    };
    const token = this.options.tokenProvider ? this.options.tokenProvider(claims) : this.options.token;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'cnp-portal', version: '1.0.0' });
    const { url, origin } = this.options;
    const timeoutMs = tool === gcpCloudAssistToolName ? this.options.gcaTimeoutMs : this.options.timeoutMs;
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const headers = { Authorization: `Bearer ${token}`, Origin: origin };
      if (this.options.iamAudience) headers['X-Serverless-Authorization'] = `Bearer ${await this.identityToken()}`;
      const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers, redirect: 'error' } });
      await client.connect(transport, { signal, timeout: timeoutMs });
      const available = await client.listTools({}, { signal, timeout: timeoutMs });
      if (!available.tools.some((item) => item.name === tool)) throw new Error('TOOL_UNAVAILABLE');
      const result = await client.callTool({ name: tool, arguments: validated, _meta: { correlationId } },
        undefined, { signal, timeout: timeoutMs });
      const content = result.structuredContent || JSON.parse(result.content.find((item) => item.type === 'text').text);
      const response = schemas.response.parse(content);
      if (response.meta.correlationId !== correlationId) throw new Error('INVALID_MCP_RESPONSE');
      return response;
    } catch (error) {
      const status = error.code;
      const cause = error.cause && error.cause.code;
      const code = ['TOOL_UNAVAILABLE', 'MCP_IAM_TOKEN_UNAVAILABLE'].includes(error.message) ? error.message
        : status === 401 ? 'MCP_UNAUTHENTICATED'
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
