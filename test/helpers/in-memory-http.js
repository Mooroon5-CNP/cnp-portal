'use strict';

const { IncomingMessage, ServerResponse } = require('http');
const { Duplex } = require('stream');

// Exercise real Express/session/body-parser middleware without opening a TCP socket.
function request(app, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const req = new IncomingMessage(socket);
    req.method = method; req.url = url;
    req.headers = { host: 'localhost:3001', ...headers, ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}) };
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const wire = Buffer.concat(chunks).toString();
      resolve({ status: res.statusCode, headers: res.getHeaders(), text: wire.slice(wire.indexOf('\r\n\r\n') + 4) });
      socket.destroy();
    });
    if (body) req.push(body);
    req.complete = true;
    req.push(null);
    app(req, res);
  });
}
function cookie(response) { return response.headers['set-cookie']?.[0]?.split(';')[0]; }
module.exports = { request, cookie };
