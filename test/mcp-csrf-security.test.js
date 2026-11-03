'use strict';

const { createRouter } = require('../apps/orchestrator/src/http/router');
test('a multibyte CSRF header is refused without crashing the route', async () => {
  const chatService = { turn: jest.fn() };
  const router = createRouter({ requireAuth: (_req, _res, next) => next(), chatService });
  const handler = router.stack.find(layer => layer.route?.path === '/api/v1/mcp/chat/turn').route.stack.at(-1).handle;
  const req = { session: { mcpCsrfToken: 'a'.repeat(64) }, get: () => 'é'.repeat(64) };
  const res = { status: jest.fn(), json: jest.fn() }; res.status.mockReturnValue(res);
  await handler(req, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(chatService.turn).not.toHaveBeenCalled();
});
