// WP-13 · S5 — Security headers + same-origin CORS tests.
// Drives the real app (temp DB + session) with raw HTTP so Origin headers can be
// controlled. Proves headers are opt-in and off by default, CSP is report-only,
// HSTS is opt-in, and CORS echoes only same-origin (never wildcard/cross-origin).
require('../helpers/network-guard');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startTestApp } = require('../helpers/app');

const S5_ENV = ['ENABLE_SECURITY_HEADERS', 'ENABLE_CSP', 'CSP_REPORT_ONLY', 'ENABLE_HSTS'];
const clearEnv = () => { for (const k of S5_ENV) delete process.env[k]; };
afterEach(clearEnv);

async function startApp(env = {}) {
  clearEnv();
  Object.assign(process.env, env);
  const app = await startTestApp();
  clearEnv();
  return app;
}

// Raw request with arbitrary headers (harness client can't set Origin).
function raw(baseUrl, method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d })); },
    );
    r.on('error', reject);
    r.end();
  });
}

// 1 + 6. Default config: no security headers, no HSTS.
test('S5-1/6. default config adds no security headers and no HSTS', async () => {
  const app = await startApp();
  try {
    const r = await raw(app.baseUrl, 'GET', '/health');
    assert.equal(r.status, 200);
    for (const hdr of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'x-permitted-cross-domain-policies', 'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only']) {
      assert.equal(r.headers[hdr], undefined, `${hdr} absent by default`);
    }
  } finally { await app.close(); }
});

// 2. ENABLE_SECURITY_HEADERS=true adds the safe static headers.
test('S5-2. ENABLE_SECURITY_HEADERS=true adds the safe headers', async () => {
  const app = await startApp({ ENABLE_SECURITY_HEADERS: 'true' });
  try {
    const r = await raw(app.baseUrl, 'GET', '/health');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['x-permitted-cross-domain-policies'], 'none');
    assert.equal(r.headers['strict-transport-security'], undefined, 'no HSTS unless enabled');
  } finally { await app.close(); }
});

// 3 + 4. CSP is report-only only; enforcing CSP is never emitted.
test('S5-3/4. ENABLE_CSP=true emits only report-only CSP; enforcing CSP never emitted', async () => {
  const app = await startApp({ ENABLE_CSP: 'true' }); // CSP_REPORT_ONLY defaults true
  try {
    const r = await raw(app.baseUrl, 'GET', '/health');
    assert.ok(typeof r.headers['content-security-policy-report-only'] === 'string', 'report-only CSP present');
    assert.ok(r.headers['content-security-policy-report-only'].includes("default-src 'self'"));
    assert.equal(r.headers['content-security-policy'], undefined, 'enforcing CSP absent');
  } finally { await app.close(); }
  // even with CSP_REPORT_ONLY=false, S5 emits neither CSP header
  const app2 = await startApp({ ENABLE_CSP: 'true', CSP_REPORT_ONLY: 'false' });
  try {
    const r = await raw(app2.baseUrl, 'GET', '/health');
    assert.equal(r.headers['content-security-policy'], undefined, 'no enforcing CSP');
    assert.equal(r.headers['content-security-policy-report-only'], undefined, 'no report-only CSP when report-only disabled');
  } finally { await app2.close(); }
});

// 5. ENABLE_HSTS=true adds HSTS.
test('S5-5. ENABLE_HSTS=true adds Strict-Transport-Security', async () => {
  const app = await startApp({ ENABLE_HSTS: 'true' });
  try {
    const r = await raw(app.baseUrl, 'GET', '/health');
    assert.equal(r.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
  } finally { await app.close(); }
});

// 7 + 8 + 13. Static/SPA + /health still respond; default API response unchanged.
test('S5-7/8/13. static, /health, and default API responses are unchanged', async () => {
  const app = await startApp();
  try {
    assert.equal((await raw(app.baseUrl, 'GET', '/')).status, 200, 'SPA/static responds');
    assert.equal((await raw(app.baseUrl, 'GET', '/health')).status, 200, '/health responds');
    // a normal API GET without Origin carries no CORS/security headers by default
    const api = await raw(app.baseUrl, 'GET', '/health');
    for (const hdr of ['access-control-allow-origin', 'access-control-allow-credentials', 'x-content-type-options']) {
      assert.equal(api.headers[hdr], undefined, `${hdr} absent on default API response`);
    }
  } finally { await app.close(); }
});

// 9 + 12. Same-origin Origin is echoed (never a wildcard).
test('S5-9/12. same-origin Origin is echoed, never wildcard', async () => {
  const app = await startApp();
  try {
    const r = await raw(app.baseUrl, 'GET', '/health', { Origin: app.baseUrl });
    assert.equal(r.headers['access-control-allow-origin'], app.baseUrl, 'echoes the exact origin');
    assert.notEqual(r.headers['access-control-allow-origin'], '*', 'never wildcard');
    assert.equal(r.headers['access-control-allow-credentials'], 'true');
    assert.ok((r.headers.vary || '').toLowerCase().includes('origin'), 'Vary: Origin set');
  } finally { await app.close(); }
});

// 10. Cross-origin Origin is NOT echoed.
test('S5-10. cross-origin Origin is not echoed', async () => {
  const app = await startApp();
  try {
    const r = await raw(app.baseUrl, 'GET', '/health', { Origin: 'http://evil.example.com' });
    assert.equal(r.headers['access-control-allow-origin'], undefined, 'no ACAO for cross-origin');
    assert.equal(r.headers['access-control-allow-credentials'], undefined);
  } finally { await app.close(); }
});

// 11. OPTIONS same-origin preflight returns 204 with safe CORS headers.
test('S5-11. OPTIONS same-origin preflight returns 204 with safe CORS headers', async () => {
  const app = await startApp();
  try {
    const r = await raw(app.baseUrl, 'OPTIONS', '/api/staff', { Origin: app.baseUrl });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], app.baseUrl);
    assert.ok((r.headers['access-control-allow-methods'] || '').includes('POST'));
    assert.notEqual(r.headers['access-control-allow-origin'], '*');
    // cross-origin OPTIONS is NOT short-circuited with CORS headers
    const x = await raw(app.baseUrl, 'OPTIONS', '/api/staff', { Origin: 'http://evil.example.com' });
    assert.equal(x.headers['access-control-allow-origin'], undefined, 'no CORS for cross-origin preflight');
  } finally { await app.close(); }
});
