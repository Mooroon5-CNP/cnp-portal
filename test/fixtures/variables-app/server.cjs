'use strict';
const http = require('http');
http.createServer((_req, res) => {
  const variableConfigured = typeof process.env.CNP_TEST_VAR === 'string' && process.env.CNP_TEST_VAR.length > 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, variableConfigured }));
}).listen(Number(process.env.PORT || 8080), '0.0.0.0');
