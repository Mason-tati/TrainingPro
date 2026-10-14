// WP-08 · L2 — request correlation over HTTP (X-Request-Id).
// Isolated harness; the only observable behaviour change is the response header.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestApp } = require('../helpers/app');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// Minimal raw request supporting custom headers (the harness helper does not).
function rawReq(baseUrl, method, urlPath, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: headers || {} },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); }
    );
    req.on('error', reject);
    req.end();
  });
}

// 1/3. An incoming X-Request-Id is preserved and echoed in the response.
test('1/3. existing X-Request-Id is preserved and echoed', async () => {
  const r = await rawReq(app.baseUrl, 'GET', '/api/auth/me', { 'X-Request-Id': 'client-fixed-123' });
  assert.equal(r.headers['x-request-id'], 'client-fixed-123');
});

// 2. A request id is generated when none is supplied.
test('2. request id is generated when absent', async () => {
  const r = await rawReq(app.baseUrl, 'GET', '/api/auth/me', {});
  assert.equal(typeof r.headers['x-request-id'], 'string');
  assert.ok(r.headers['x-request-id'].length >= 16, 'generated id is non-trivial');
});

// 5. Parallel requests receive unique request ids.
test('5. parallel requests get unique request ids', async () => {
  const [a, b, c] = await Promise.all([
    rawReq(app.baseUrl, 'GET', '/api/auth/me', {}),
    rawReq(app.baseUrl, 'GET', '/api/auth/me', {}),
    rawReq(app.baseUrl, 'GET', '/api/auth/me', {}),
  ]);
  const ids = [a, b, c].map((r) => r.headers['x-request-id']);
  assert.equal(new Set(ids).size, 3, 'all three ids are distinct');
});

// 8. Existing behaviour unchanged: authenticated request still works and carries the header.
test('8. existing behaviour is unchanged (status + header)', async () => {
  const authed = await app.request('GET', '/api/staff');           // 200 with admin cookie
  assert.equal(authed.status, 200);
  assert.ok(authed.headers['x-request-id'], 'authenticated response carries the header');
  const anon = await app.request('GET', '/api/staff', null, null); // still 401 without session
  assert.equal(anon.status, 401);
  assert.ok(anon.headers['x-request-id'], 'even 401 responses carry the header');
});
