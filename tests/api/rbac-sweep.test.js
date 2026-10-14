// WP-14 · A8 — Final RBAC safety sweep.
// End-to-end proof that the WP-14 RBAC foundation is behaviour-neutral: login and
// the existing admin-flag enforcement are unchanged, sessions carry additive
// roles/permissions, the report-only authorization layer never denies, matched
// routes emit a count-only audit event, unmatched routes emit nothing, no route
// imports the RBAC modules, and production DBs are untouched.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const AUTH_META_KEYS = ['method', 'path', 'matchedRoute', 'authorized', 'requiredPermissionCount', 'evaluatedPermissionCount', 'missingPermissionCount', 'mode', 'roleCount'];

let app;
let authRoutes;
let authorize;
before(async () => {
  app = await startTestApp();
  authRoutes = require(path.join(ROOT, 'routes', 'auth.js')); // app instance (temp DB)
  authorize = require(path.join(ROOT, 'lib', 'auth', 'authorize.js'));
  // a non-admin user for the old-flag enforcement check
  await app.db.dbRun(
    "INSERT INTO tblPswd (UserName,Password,HashPass,Admin,UserStatus,DateChanged) VALUES ('rbac_user','userpass','$2a$10$placeholder',0,'Active',date('now'))",
  );
});
after(async () => { if (app) await app.close(); });

async function loginCookie(username, password) {
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username, password });
  const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, cookie };
}
function capture() {
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  return { rows, stop() { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); } };
}

// 1-6. Login works; session carries additive roles/permissions; admin gets ADMIN + admin.full.
test('A8-sweep-1..6. login + additive admin session context', async () => {
  const login = await loginCookie('admin', 'admin123');
  assert.equal(login.status, 200, 'login works (1)');
  const me = (await app.request('GET', '/api/auth/me')).json();
  assert.ok(me.admin, 'existing admin flag still works (2)');
  assert.ok(Array.isArray(me.roles), 'session has roles array (3)');
  assert.ok(Array.isArray(me.permissions), 'session has permissions array (4)');
  assert.ok(me.roles.includes('ADMIN'), 'admin includes ADMIN (5)');
  assert.ok(me.permissions.includes('admin.full'), 'admin includes admin.full (6)');
});

// 7. Non-admin with no role info → no roles/permissions.
test('A8-sweep-7. non-admin without role → empty roles/permissions', () => {
  assert.deepEqual(authRoutes.deriveSessionPermissions({ Admin: 0 }), { roles: [], permissions: [] });
});

// 8. Existing admin-only route enforcement still comes from the OLD admin flag.
test('A8-sweep-8. admin-only route enforced by the existing admin flag', async () => {
  assert.equal((await app.request('GET', '/api/users')).status, 200, 'admin allowed (existing flag)');
  const nonAdmin = await loginCookie('rbac_user', 'userpass');
  assert.equal(nonAdmin.status, 200, 'non-admin can log in');
  assert.equal((await app.request('GET', '/api/users', null, nonAdmin.cookie)).status, 403, 'non-admin 403 from old flag, not RBAC');
});

// 9 + 10. Authorization report exists and never denies.
test('A8-sweep-9/10. authorization report exists and never denies', async () => {
  const report = authorize.buildAuthorizationReport({ method: 'GET', path: '/api/users', session: { user: { roles: ['ADMIN'] } } });
  assert.equal(report.matchedRoutePermission, true, 'report exists for a matched route (9)');
  // a matched route with the admin session is served normally — never a 403 from the report layer
  assert.notEqual((await app.request('GET', '/api/reports/summary')).status, 403, 'report never denies (10)');
});

// 11-17. Matched route emits a count-only, identity-free AUTHORIZATION_REPORT; unmatched emits none.
test('A8-sweep-11..17. audit event is emitted, count-only, and content-free', async () => {
  const cap = capture();
  try {
    await app.request('GET', '/api/users'); // admin, matched → emits
    await app.request('GET', '/api/nonexistent-sweep'); // unmatched → no emit
    cap.stop();
    const events = cap.rows.filter((r) => r.event === 'AUTHORIZATION_REPORT');
    assert.ok(events.length >= 1, 'matched route emits AUTHORIZATION_REPORT (11)');
    assert.ok(events.every((e) => e.metadata.path !== '/api/nonexistent-sweep'), 'unmatched route emits nothing (12)');
    const rec = events[0];
    assert.deepEqual(Object.keys(rec.metadata).sort(), [...AUTH_META_KEYS].sort(), 'only counts (13)');
    for (const k of ['requiredPermissionCount', 'evaluatedPermissionCount', 'missingPermissionCount', 'roleCount']) {
      assert.equal(typeof rec.metadata[k], 'number');
    }
    const s = JSON.stringify(events);
    const cookieValue = (app.cookie || '').split('=').slice(1).join('=');
    for (const leak of ['admin', 'ADMIN', 'users.read', 'admin.full', 'connect.sid', cookieValue].filter(Boolean)) {
      assert.ok(!s.includes(leak), `no ${leak} in the audit records (14-17)`);
    }
  } finally { cap.stop(); }
});

// 18 + 19 + 20. No route imports the RBAC modules; no route enforcement exists.
test('A8-sweep-18/19/20. no route imports RBAC modules; no enforcement', () => {
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
    // auth.js legitimately imports user-permissions (A3); no route imports authorize/route-permissions.
    assert.ok(!src.includes('auth/authorize'), `${f} must not import auth/authorize (18)`);
    assert.ok(!src.includes('auth/route-permissions'), `${f} must not import auth/route-permissions (19)`);
  }
});

// 21. Tests run against an isolated temp DB/session (production untouched).
test('A8-sweep-21. isolated temp DB/session', () => {
  assert.ok(app.dbPath.includes('.tmp'), 'temp DB under tests/.tmp');
  assert.ok(!app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`), 'not the production DB');
  assert.ok(app.sessDir.includes('.tmp'), 'temp session dir under tests/.tmp');
});
