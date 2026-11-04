'use strict';
const { adapt } = require('../scripts/platform/install-runtime.cjs');
test('Pixel App Node 20 Dockerfile keeps tini, argv, non-root identity and build stages', () => {
  const source = 'FROM node:20-alpine AS deps\nWORKDIR /app\nRUN npm ci --omit=dev\nFROM node:20-alpine\nWORKDIR /app\nUSER 1000\nENTRYPOINT ["/sbin/tini", "--"]\nCMD ["node", "src/index.js"]\n';
  const result = adapt(source);
  expect(result).toContain('FROM node:20-alpine AS deps'); expect(result).toContain('USER 1000');
  expect(result).toContain('LABEL io.cnp.variables-contract="1"');
  expect(result).toContain('CMD ["/sbin/tini","--","node","src/index.js"]');
  expect(result).toContain('ENTRYPOINT ["node", "/opt/cnp/runtime/start.cjs"]');
});
test('refuses a silent rewrite of shell startup or unsupported image runtime', () => {
  expect(() => adapt('FROM node:20-alpine\nCMD node server.js\n')).toThrow('shell');
  expect(() => adapt('FROM python:3.12\nCMD ["python", "app.py"]\n')).toThrow('runtime');
});
test('can launch another application process in an image with the runtime installed', () => {
  expect(adapt('FROM node:24-alpine\nCMD ["python3", "app.py", "--port", "8080"]\n')).toContain('CMD ["python3","app.py","--port","8080"]');
});
