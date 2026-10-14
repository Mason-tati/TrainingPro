// WP-14 · A3 — Session permission context tests.
// Proves login attaches additive roles/permissions to the session (admins get
// ADMIN), /api/auth/me exposes them, existing fields/behaviour are unchanged,
// and no route enforces permissions.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const AUTH_PATH = path.join(ROOT, 'routes', 'auth.js');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

const me = (cookie) => app.request('GET', '/api/auth/me', null, cookie);
async function freshLogin(username, password) {
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username, password });
  const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return { r, cookie };
}

// 1 + 2 + 3 + 4 + 5 + 8. Admin session context is additive and correct.
test('A3-1..5/8. admin login: additive roles/permissions; existing fields intact', async () => {
  const r = await me(); // harness admin cookie
  assert.equal(r.status, 200);
  const u = r.json();
  assert.ok(Array.isArray(u.roles) && u.roles.includes('ADMIN'), 'ADMIN role present (1)');
  assert.ok(Array.isArray(u.permissions) && u.permissions.includes('admin.full'), 'admin.full present (2)');
  assert.ok(u.admin, 'existing admin flag still truthy (3)');
  assert.equal(u.username, 'admin', 'username unchanged (4)');
  assert.equal(u.pageAccess, '', 'PageAccess unchanged (5)');
  // additive: existing fields still present alongside the new ones (8)
  for (const k of ['id', 'username', 'admin', 'pageAccess', 'roles', 'permissions']) assert.ok(k in u, `${k} present`);
});

// 6. Non-admin user with no role info → no roles, no permissions.
test('A3-6. non-admin without role info → empty roles/permissions', () => {
  const authRoutes = require(AUTH_PATH); // app instance (temp DB already configured)
  assert.deepEqual(authRoutes.deriveSessionPermissions({ Admin: 0 }), { roles: [], permissions: [] });
  assert.deepEqual(authRoutes.deriveSessionPermissions({}), { roles: [], permissions: [] });
});

// 7. Non-admin with role TRAINER → inherited VIEWER/OPERATOR permissions.
test('A3-7. TRAINER derives inherited permissions', () => {
  const authRoutes = require(AUTH_PATH);
  const { roles, permissions } = authRoutes.deriveSessionPermissions({ Admin: 0, role: 'TRAINER' });
  assert.deepEqual(roles, ['TRAINER']);
  for (const p of ['training.read', 'documents.read', 'competency.read', 'training.write', 'ai.use']) {
    assert.ok(permissions.includes(p), `TRAINER has ${p}`);
  }
  assert.ok(!permissions.includes('admin.full'), 'TRAINER is not admin');
});

// 9. Session persistence retains roles/permissions across requests.
test('A3-9. roles/permissions persist across requests', async () => {
  const { cookie } = await freshLogin('admin', 'admin123');
  assert.ok((await me(cookie)).json().permissions.includes('admin.full'), 'first request');
  const second = await me(cookie);
  assert.ok(second.json().roles.includes('ADMIN') && second.json().permissions.includes('admin.full'), 'persisted on a later request');
});

// 10. Logout clears the permission context.
test('A3-10. logout clears the permission context', async () => {
  const { cookie } = await freshLogin('admin', 'admin123');
  assert.equal((await me(cookie)).status, 200, 'authed before logout');
  await app.request('POST', '/api/auth/logout', null, cookie);
  assert.equal((await me(cookie)).status, 401, 'no context after logout');
});

// 11. Failed login creates no permission context.
test('A3-11. failed login → no context', async () => {
  const { r, cookie } = await freshLogin('admin', 'wrong-password');
  assert.equal(r.status, 401, 'login failed');
  assert.equal((await me(cookie)).status, 401, 'no session/context established');
});

// 12. An authenticated request runs through the (now RBAC-aware) context binding.
test('A3-12. authenticated request binds context (actor) without error', async () => {
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  try {
    const r = await me(); // admin cookie
    app.appLogger.__setLevel('silent'); app.appLogger.__resetSink();
    assert.equal(r.status, 200, 'request succeeds with the augmented binding');
    assert.ok(rows.some((rec) => rec.actor === 'admin'), 'actor bound → the RBAC-aware binding block executed');
    // the session it binds carries roles/permissions
    assert.ok(r.json().roles.includes('ADMIN'));
  } finally { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); }
});

// 13. No route enforcement: normal authed requests are unaffected (no new 403s).
test('A3-13. no permission enforcement on routes', async () => {
  assert.equal((await app.request('GET', '/health', null, null)).status, 200);
  assert.equal((await app.request('GET', '/api/auth/me')).status, 200, 'authed route unchanged');
  // admin still reaches an admin-only route via the EXISTING admin flag (not the new perms)
  assert.equal((await app.request('GET', '/api/users')).status, 200);
});
