// WP-14 · A4 — Report-only authorization (API) tests.
// Proves the globally-mounted authorization context middleware is behaviour-neutral:
// authenticated requests succeed, nothing returns 401/403 from the new layer, and
// existing API behaviour is unchanged.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// 1. Authenticated requests still succeed (global middleware is transparent).
test('A4-api-1. authenticated requests succeed unchanged', async () => {
  assert.equal((await app.request('GET', '/api/auth/me')).status, 200, '/me still 200');
  assert.equal((await app.request('GET', '/api/users')).status, 200, 'admin route still 200');
  assert.equal((await app.rawRequest(app.baseUrl, 'GET', '/health', null, null)).status, 200, '/health still 200');
});

// 2. No new 401/403 from the report-only layer; existing auth semantics intact.
test('A4-api-2. no new 401/403 from the report-only layer', async () => {
  // anonymous access to a protected route still 401 (existing behaviour, not the new layer)
  assert.equal((await app.request('GET', '/api/auth/me', null, null)).status, 401, 'existing 401 preserved');
  // a bad login still 401 (unchanged)
  const bad = await app.request('POST', '/api/auth/login', { username: 'admin', password: 'nope' }, null);
  assert.equal(bad.status, 401);
  // a successful admin login still 200 with the same body shape
  const ok = await app.request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, null);
  assert.equal(ok.status, 200);
  assert.equal(ok.json().success, true);
});

// 3. The global authorization context middleware runs on every request without
//    changing responses (proven via a live unit-style exercise of the middleware).
test('A4-api-3. authorization context is created, report-only', () => {
  const requestContext = require(path.join(ROOT, 'lib', 'request-context.js'));
  const { initAuthorizationContext, authorize } = require(path.join(ROOT, 'lib', 'auth', 'authorize.js'));
  requestContext.run({ module: 'System' }, () => {
    let nexted = false;
    initAuthorizationContext({ session: { user: { roles: ['ADMIN'] } } }, {}, () => { nexted = true; });
    assert.equal(nexted, true, 'always calls next()');
    assert.ok(requestContext.get().authorization, 'authorization context created');
    // a route-level authorizer records an advisory result but never denies
    authorize('admin.full')({ session: { user: { roles: ['ADMIN'] } } }, {}, () => {});
    assert.equal(requestContext.get().authorization.authorized, true);
  });
});

// 4. Existing API behaviour (a normal data endpoint) is unchanged.
test('A4-api-4. existing API responses unchanged', async () => {
  const staff = await app.request('POST', '/api/staff', { LastName: 'A4', FirstName: 'Rep', Status: 'Active', FileNum: 'A4-1' });
  assert.equal(staff.status, 200, 'staff create unchanged');
  assert.ok(staff.json().StaffID, 'response body shape unchanged');
});
