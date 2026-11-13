'use strict';
const proxyaddr = require('proxy-addr');
const request = remoteAddress => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': '203.0.113.7' } });

test.each(['::ffff:10.0.0.0/8', '::/1'])('CVE-2026-90711: %s cannot trust arbitrary IPv4 senders', subnet => {
  expect(proxyaddr(request('198.51.100.42'), proxyaddr.compile(subnet))).toBe('198.51.100.42');
});
test('correctly configured proxy subnets still resolve the forwarded client', () => {
  for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
    expect(proxyaddr(request('10.1.2.3'), proxyaddr.compile(subnet))).toBe('203.0.113.7');
  }
});
