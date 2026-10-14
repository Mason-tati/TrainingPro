// WP-14 · A6 — Route permission reporting (API) tests.
// Proves the enriched report-only authorization context is computed per request
// from the A5 registry + session user, while never denying, mutating, or altering
// any response, and never logging the report.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
let app;
let authorize;
before(async () => {
  app = await startTestApp();
  authorize = require(path.join(ROOT, 'lib', 'auth', 'authorize.js')); // app instance
});
after(async () => { if (app) await app.close(); });

const ADMIN = { roles: ['ADMIN'] };
const VIEWER = { roles: ['VIEWER'] };
const buildReq = (method, p, user) => ({ method, path: p, session: user ? { user } : {} });

// 1. Unknown route → matchedRoutePermission false, does not deny.
test('A6-api-1. unknown route report has matchedRoutePermission false', () => {
  const r = authorize.buildAuthorizationReport(buildReq('GET', '/api/unknown-thing', ADMIN));
  assert.equal(r.matchedRoutePermission, false);
  assert.equal(r.authorized, true);
  assert.deepEqual(r.requiredPermissions, []);
  assert.equal(r.routePermissionRule, null);
});

// 2 + 10 + 11. Known/unknown routes never denied; responses unchanged; no new 401/403.
test('A6-api-2/10/11. no denial, no status/body change, no new 401/403', async () => {
  assert.equal((await app.rawRequest(app.baseUrl, 'GET', '/health', null, null)).status, 200);
  const users = await app.request('GET', '/api/users'); // admin cookie
  assert.equal(users.status, 200, 'known route unchanged');
  const me = await app.request('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  // existing 401 (anonymous protected) preserved — from the EXISTING auth, not the report layer
  assert.equal((await app.request('GET', '/api/auth/me', null, null)).status, 401);
});

// 3 + 6 + 7. Known route + admin → authorized true; required/evaluated populated.
test('A6-api-3/6/7. admin satisfies a known route', () => {
  const r = authorize.buildAuthorizationReport(buildReq('GET', '/api/users', ADMIN));
  assert.equal(r.matchedRoutePermission, true);
  assert.deepEqual(r.requiredPermissions, ['users.read'], 'required from registry (6)');
  assert.ok(r.evaluatedPermissions.includes('users.read'), 'evaluated from session user (7)');
  assert.equal(r.authorized, true);
});

// 4 + 5. Insufficient user → authorized false, missingPermissions populated; response still normal.
test('A6-api-4/5. insufficient user reports authorized false without denying', async () => {
  const r = authorize.buildAuthorizationReport(buildReq('DELETE', '/api/users/9', VIEWER));
  assert.equal(r.authorized, false);
  assert.deepEqual(r.missingPermissions, ['users.delete'], 'missing populated (5)');
  // the real admin request to a known route is still served normally (no enforcement)
  assert.equal((await app.request('GET', '/api/users')).status, 200);
});

// 8. routePermissionRule is a copy, not a registry reference.
test('A6-api-8. routePermissionRule is a copy', () => {
  const r = authorize.buildAuthorizationReport(buildReq('GET', '/api/users', ADMIN));
  r.routePermissionRule.permissions.push('admin.full');
  const again = authorize.buildAuthorizationReport(buildReq('GET', '/api/users', ADMIN));
  assert.deepEqual(again.requiredPermissions, ['users.read'], 'registry unaffected');
});

// 9. No request/session mutation across a real authenticated request.
test('A6-api-9. no session mutation on a real request', async () => {
  const before = (await app.request('GET', '/api/auth/me')).json();
  await app.request('GET', '/api/users'); // triggers the report middleware
  const afterMe = (await app.request('GET', '/api/auth/me')).json();
  assert.deepEqual(afterMe.roles, before.roles, 'session roles unchanged');
  assert.deepEqual(afterMe.permissions, before.permissions, 'session permissions unchanged');
});

// 12. The authorization report is NOT logged.
test('A6-api-12. authorization report emits no logs', async () => {
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  try {
    await app.request('GET', '/api/users');
    app.appLogger.__setLevel('silent'); app.appLogger.__resetSink();
    const s = JSON.stringify(rows);
    for (const key of ['matchedRoutePermission', 'requiredPermissions', 'evaluatedPermissions', 'missingPermissions', 'routePermissionRule']) {
      assert.ok(!s.includes(key), `report key ${key} not logged`);
    }
  } finally { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); }
});
