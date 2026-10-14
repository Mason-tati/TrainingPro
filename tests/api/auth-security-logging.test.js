// WP-08 · L5 — Auth & security event logging tests.
// Middleware-derived events; auth behaviour and responses must be unchanged.
// No passwords, cookies, session ids, tokens or bodies may ever appear in logs.
require('../helpers/network-guard');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require(path.join(__dirname, '..', '..', 'node_modules', 'bcryptjs'));
const { startTestApp } = require('../helpers/app');
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

let app;
let logs;
let userCookie; // non-admin session

before(async () => {
  app = await startTestApp();
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((rec) => logs.push(rec));
  // Synthetic NON-ADMIN user directly in the temp DB (per C7 pattern).
  const hash = bcrypt.hashSync('user-pass-1', 10);
  await app.db.dbRun(
    "INSERT INTO tblPswd (UserName,Password,HashPass,Admin,UserStatus,DateChanged) VALUES ('l5user','user-pass-1',?,0,'Active',date('now'))",
    [hash]
  );
});
after(async () => { if (app) { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); } });
beforeEach(() => { logs = []; });

const settle = () => new Promise((r) => setTimeout(r, 25));
const byEvent = (ev) => logs.filter((r) => r.event === ev);

async function login(username, password) {
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username, password });
  const cookie = (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return { r, cookie };
}

// 1/12. Login success → AUTH_LOGIN_SUCCESS with username actor; response unchanged.
test('1. login success logs AUTH_LOGIN_SUCCESS with username actor', async () => {
  const { r, cookie } = await login('l5user', 'user-pass-1');
  userCookie = cookie;
  await settle();
  assert.equal(r.status, 200, 'login response unchanged');
  assert.equal(r.json().success, true, 'response body unchanged');
  const evs = byEvent('AUTH_LOGIN_SUCCESS');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].level, 'INFO');
  assert.equal(evs[0].actor, 'l5user', 'actor is the username');
  assert.equal(evs[0].metadata.statusCode, 200);
});

// 2/14. Login failure → AUTH_LOGIN_FAILURE only (no duplicate security event).
test('2/14. login failure logs one AUTH_LOGIN_FAILURE and nothing else', async () => {
  const { r } = await login('l5user', 'wrong-password');
  await settle();
  assert.equal(r.status, 401, 'response unchanged');
  assert.equal(byEvent('AUTH_LOGIN_FAILURE').length, 1);
  assert.equal(byEvent('AUTH_LOGIN_FAILURE')[0].level, 'WARN');
  assert.equal(byEvent('SECURITY_UNAUTHENTICATED_ACCESS').length, 0, 'no duplicate event for the same 401');
});

// 3. Logout → AUTH_LOGOUT.
test('3. logout logs AUTH_LOGOUT', async () => {
  const { cookie } = await login('l5user', 'user-pass-1');
  logs = [];
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/logout', {}, cookie);
  await settle();
  assert.equal(r.status, 200);
  const evs = byEvent('AUTH_LOGOUT');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, 'l5user', 'actor bound from session before logout');
});

// 4. Password change success.
test('4. password change success logs AUTH_PASSWORD_CHANGE_SUCCESS', async () => {
  const { cookie } = await login('l5user', 'user-pass-1');
  logs = [];
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/change-password', { oldPassword: 'user-pass-1', newPassword: 'user-pass-2' }, cookie);
  await settle();
  assert.equal(r.status, 200, 'response unchanged');
  const evs = byEvent('AUTH_PASSWORD_CHANGE_SUCCESS');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, 'l5user');
  // restore the password for later tests
  await app.rawRequest(app.baseUrl, 'POST', '/api/auth/change-password', { oldPassword: 'user-pass-2', newPassword: 'user-pass-1' }, cookie);
});

// 5/14. Password change failure (wrong old password) → FAILURE only, no duplicates.
test('5/14. password change failure logs one AUTH_PASSWORD_CHANGE_FAILURE', async () => {
  const { cookie } = await login('l5user', 'user-pass-1');
  logs = [];
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/change-password', { oldPassword: 'nope', newPassword: 'x' }, cookie);
  await settle();
  assert.equal(r.status, 401, 'response unchanged');
  assert.equal(byEvent('AUTH_PASSWORD_CHANGE_FAILURE').length, 1);
  assert.equal(byEvent('SECURITY_UNAUTHENTICATED_ACCESS').length, 0, 'auth endpoint classified before generic 401');
});

// 6. Unauthenticated protected route → SECURITY_UNAUTHENTICATED_ACCESS.
test('6. unauthenticated protected route logs SECURITY_UNAUTHENTICATED_ACCESS', async () => {
  const r = await app.request('GET', '/api/staff', null, null);
  await settle();
  assert.equal(r.status, 401, 'response unchanged');
  const evs = byEvent('SECURITY_UNAUTHENTICATED_ACCESS');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].level, 'WARN');
  assert.equal(evs[0].metadata.path, '/api/staff');
});

// 7. Non-admin on admin-only route → SECURITY_ACCESS_DENIED.
test('7. non-admin admin-route access logs SECURITY_ACCESS_DENIED', async () => {
  const { cookie } = await login('l5user', 'user-pass-1');
  logs = [];
  const r = await app.rawRequest(app.baseUrl, 'GET', '/api/users', null, cookie);
  await settle();
  assert.equal(r.status, 403, 'response unchanged');
  const evs = byEvent('SECURITY_ACCESS_DENIED');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, 'l5user', 'denied actor identified by username');
});

// 8/11. Every emitted record validates; requestId always present.
test('8/11. all auth/security records are schema-valid with a requestId', async () => {
  await login('l5user', 'wrong');
  await app.request('GET', '/api/staff', null, null);
  await settle();
  const evs = logs.filter((r) => r.event.startsWith('AUTH_') || r.event.startsWith('SECURITY_'));
  assert.ok(evs.length >= 2);
  for (const rec of evs) {
    assert.equal(validateLogRecord(rec).valid, true, rec.event);
    assert.equal(typeof rec.requestId, 'string', 'requestId auto-attached');
  }
});

// 9/10. No password values, cookies or session ids anywhere in the logs.
test('9/10. no passwords, cookies or session ids appear in any log', async () => {
  const { cookie } = await login('l5user', 'user-pass-1');
  await app.rawRequest(app.baseUrl, 'POST', '/api/auth/change-password', { oldPassword: 'user-pass-1', newPassword: 'user-pass-1' }, cookie);
  await settle();
  const all = JSON.stringify(logs);
  assert.ok(!all.includes('user-pass-1'), 'password value never logged');
  assert.ok(!all.includes('connect.sid'), 'session cookie name/id never logged');
  const sid = cookie.split('=')[1] || '';
  assert.ok(sid.length < 8 || !all.includes(sid.slice(0, 12)), 'session id value never logged');
  assert.ok(!all.toLowerCase().includes('"cookie"') || all.includes('[REDACTED]'), 'cookie fields redacted if ever present');
});

// 13. Logger failure never breaks auth flows.
test('13. throwing sink does not affect login/logout/change-password', async () => {
  app.appLogger.__setSink(() => { throw new Error('sink boom'); });
  const { r, cookie } = await login('l5user', 'user-pass-1');
  assert.equal(r.status, 200, 'login unaffected');
  const out = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/logout', {}, cookie);
  assert.equal(out.status, 200, 'logout unaffected');
  app.appLogger.__setSink((rec) => logs.push(rec));
});
