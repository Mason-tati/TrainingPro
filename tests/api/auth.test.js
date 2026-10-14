// WP-07 · C7 — Authentication + permission API tests (in-process app harness).
// Uses a temporary DATABASE_PATH and a per-instance temporary SESSION_DB_DIR.
// The production DB (database/traintrack.db) and production session DB
// (database/sessions.db) are never touched. No AI, no SMTP, no external services.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

// Insert a synthetic user straight into the temp DB (no UI, no production logic).
// HashPass = the placeholder sentinel → auth.js uses the plaintext-Password path,
// so no bcrypt dependency is needed in the test. Matches current implementation.
async function createUser(app, { username, password = 'pw123456', admin = 0, pageAccess = null, status = 'Active' }) {
  await app.db.dbRun(
    'INSERT INTO tblPswd (UserName, Password, HashPass, Admin, UserStatus, PageAccess) VALUES (?,?,?,?,?,?)',
    [username, password, '$2a$10$placeholder', admin, status, pageAccess]
  );
}

async function loginAs(app, username, password) {
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username, password });
  const setCookie = r.headers['set-cookie'] || [];
  return { status: r.status, body: r.json(), setCookie, cookie: setCookie.map((c) => c.split(';')[0]).join('; ') };
}

let app;
before(async () => {
  app = await startTestApp();
  // Synthetic users for permission + password tests.
  await createUser(app, { username: 'c7_user', password: 'userpass', admin: 0, pageAccess: 'dashboard,staff' });
  await createUser(app, { username: 'c7_pw', password: 'origpass', admin: 0 });
  await createUser(app, { username: 'c7_pw2', password: 'origpass', admin: 0 });
});
after(async () => { if (app) await app.close(); });

// 1. Unauthenticated access to protected routes → 401.
test('1. unauthenticated protected routes return 401', async () => {
  assert.equal((await app.request('GET', '/api/staff', null, null)).status, 401);
  assert.equal((await app.request('GET', '/api/users', null, null)).status, 401);
  assert.equal((await app.request('GET', '/api/me/profile', null, null)).status, 401);
});

// 2. Bad login → 401.
test('2. bad login returns 401', async () => {
  const r = await loginAs(app, 'admin', 'wrong-password');
  assert.equal(r.status, 401);
});

// 3. Valid admin login succeeds.
test('3. valid admin login succeeds', async () => {
  const r = await loginAs(app, 'admin', 'admin123');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(r.body.user.admin, 'logged-in user is admin');
});

// 4. Valid login returns a session cookie.
test('4. valid login sets a session cookie', async () => {
  const r = await loginAs(app, 'admin', 'admin123');
  assert.ok(r.setCookie.length > 0, 'Set-Cookie present');
  assert.ok(r.setCookie.some((c) => c.startsWith('connect.sid=')), 'session cookie issued');
});

// 5. Authenticated request to /api/me succeeds.
test('5. authenticated /api/me request succeeds', async () => {
  const r = await app.request('GET', '/api/me/profile'); // uses admin cookie
  assert.equal(r.status, 200);
  assert.ok('linked' in r.json(), 'returns profile shape');
});

// 6 + 7. Logout invalidates the session; protected routes then 401 again.
test('6/7. logout invalidates the session', async () => {
  const { cookie } = await loginAs(app, 'admin', 'admin123');
  assert.equal((await app.request('GET', '/api/auth/me', null, cookie)).status, 200, 'authed before logout');
  const out = await app.request('POST', '/api/auth/logout', {}, cookie);
  assert.equal(out.status, 200);
  assert.equal((await app.request('GET', '/api/auth/me', null, cookie)).status, 401, '/api/auth/me 401 after logout');
  assert.equal((await app.request('GET', '/api/staff', null, cookie)).status, 401, 'protected route 401 after logout');
});

// 8. Non-admin cannot access admin-only routes.
test('8. non-admin is forbidden from admin-only routes', async () => {
  const { cookie, status } = await loginAs(app, 'c7_user', 'userpass');
  assert.equal(status, 200, 'non-admin can log in');
  const r = await app.request('GET', '/api/users', null, cookie);
  assert.equal(r.status, 403, 'admin-only route rejects non-admin');
});

// 9. Admin can access admin-only routes.
test('9. admin can access admin-only routes', async () => {
  const r = await app.request('GET', '/api/users'); // admin cookie
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json()), 'returns the user list');
});

// 10. PageAccess is carried into the session (as currently implemented).
test('10. PageAccess is surfaced on the session', async () => {
  const nonAdmin = await loginAs(app, 'c7_user', 'userpass');
  const me = await app.request('GET', '/api/auth/me', null, nonAdmin.cookie);
  assert.equal(me.status, 200);
  assert.equal(me.json().pageAccess, 'dashboard,staff', 'stored PageAccess reflected in session');
  // Admin seeded without PageAccess → normalised to '' by auth.js.
  const adminMe = await app.request('GET', '/api/auth/me');
  assert.equal(adminMe.json().pageAccess, '');
});

// 11. Change-password succeeds for a valid authenticated user.
test('11. change-password succeeds with correct current password', async () => {
  const { cookie } = await loginAs(app, 'c7_pw', 'origpass');
  const r = await app.request('POST', '/api/auth/change-password', { oldPassword: 'origpass', newPassword: 'newpass99' }, cookie);
  assert.equal(r.status, 200);
  assert.equal(r.json().success, true);
  // New password now works; old one no longer does.
  assert.equal((await loginAs(app, 'c7_pw', 'newpass99')).status, 200);
  assert.equal((await loginAs(app, 'c7_pw', 'origpass')).status, 401);
});

// 12. Change-password rejects an invalid current password.
test('12. change-password rejects an invalid current password', async () => {
  const { cookie } = await loginAs(app, 'c7_pw2', 'origpass');
  const r = await app.request('POST', '/api/auth/change-password', { oldPassword: 'WRONG', newPassword: 'whatever1' }, cookie);
  assert.equal(r.status, 401);
});

// 13. Session persists across multiple requests using the same cookie.
test('13. session persists across multiple requests', async () => {
  const { cookie } = await loginAs(app, 'admin', 'admin123');
  const a = await app.request('GET', '/api/auth/me', null, cookie);
  const b = await app.request('GET', '/api/me/profile', null, cookie);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json().username, 'admin');
});

// 14. Session isolation between separate app instances.
test('14. sessions do not cross between isolated app instances', async () => {
  const appB = await startTestApp();
  try {
    // appB's admin cookie must NOT authenticate against appA (different store).
    const crossA = await app.request('GET', '/api/auth/me', null, appB.cookie);
    assert.equal(crossA.status, 401, "appB cookie rejected by appA");
    // and appA's cookie must not authenticate against appB.
    const crossB = await appB.request('GET', '/api/auth/me', null, app.cookie);
    assert.equal(crossB.status, 401, "appA cookie rejected by appB");
    // sanity: each cookie works against its own instance
    assert.equal((await appB.request('GET', '/api/auth/me')).status, 200);
    assert.equal((await app.request('GET', '/api/auth/me')).status, 200);
  } finally {
    await appB.close();
  }
});
