'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDocument } = require('../src/services/documentation-path');
const { browserWriteGuard } = require('../src/middleware/browser-write-guard');
const { createLoginLimiter } = require('../src/middleware/login-limit');

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-security-'));
  fs.mkdirSync(path.join(root, 'docs', 'devops'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'public'));
  fs.mkdirSync(path.join(root, 'docs-private'));
  fs.writeFileSync(path.join(root, 'docs', 'devops', 'secret.md'), 'restricted');
  fs.writeFileSync(path.join(root, 'docs-private', 'secret.md'), 'outside');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('canonical documentation paths retain DevOps classification through aliases', () => {
  for (const name of ['devops/secret.md', './devops/secret.md', 'public/../devops/secret.md']) {
    expect(resolveDocument(path.join(root, 'docs'), name).relative).toBe('devops/secret.md');
  }
});
test('documentation refuses sibling-prefix traversal and symlinks outside its root', () => {
  const docs = path.join(root, 'docs');
  expect(() => resolveDocument(docs, '../docs-private/secret.md')).toThrow();
  fs.symlinkSync(path.join(root, 'docs-private', 'secret.md'), path.join(docs, 'link.md'));
  expect(() => resolveDocument(docs, 'link.md')).toThrow();
});
test('symlink to restricted content is classified by its actual path', () => {
  const docs = path.join(root, 'docs');
  fs.symlinkSync(path.join(docs, 'devops', 'secret.md'), path.join(docs, 'public.md'));
  expect(resolveDocument(docs, 'public.md').relative).toBe('devops/secret.md');
});
function response() {
  const res = { status: jest.fn(), send: jest.fn(), setHeader: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}
test.each([
  { origin: 'https://evil.example' }, { origin: 'null' },
  { referer: 'https://evil.example/form' }, { 'sec-fetch-site': 'cross-site' },
])('cross-site browser writes are refused before route execution: %j', headers => {
  const next = jest.fn(); const res = response();
  browserWriteGuard({ method: 'POST', protocol: 'http', get: key => ({ host: 'localhost:3001', ...headers })[key] }, res, next);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(next).not.toHaveBeenCalled();
});
test('same-origin browser forms continue to work', () => {
  const next = jest.fn(); const res = response();
  browserWriteGuard({ method: 'POST', protocol: 'http', get: key => ({ host: 'localhost:3001', origin: 'http://localhost:3001' })[key] }, res, next);
  expect(next).toHaveBeenCalled();
});
test('login attempts are bounded per address and recover after the window', () => {
  let now = 0;
  const limit = createLoginLimiter({ limit: 2, windowMs: 1000, now: () => now });
  const next = jest.fn(); const res = response();
  const req = { ip: '127.0.0.1' };
  limit(req, res, next); limit(req, res, next); limit(req, res, next);
  expect(next).toHaveBeenCalledTimes(2);
  expect(res.status).toHaveBeenCalledWith(429);
  limit({ ip: '127.0.0.2' }, res, next);
  expect(next).toHaveBeenCalledTimes(3);
  now = 1000; limit(req, res, next);
  expect(next).toHaveBeenCalledTimes(4);
});

const { renderMarkdown } = require('../src/services/documentation-markdown');
test('documentation escapes raw HTML and disables executable Markdown URLs', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[execute](javascript:alert(1))\n\n![x](data:text/html,evil)');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain('src="data:');
});
test('documentation retains normal headings and links without attribute injection', () => {
  const html = renderMarkdown('# Guide\n\n[reference](https://example.com)');
  expect(html).toContain('<h1>Guide</h1>');
  expect(html).toContain('href="https://example.com"');
});
