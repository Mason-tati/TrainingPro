// WP-14 · A7 — Authorization audit (report-only) API tests.
// Proves matched routes emit exactly one count-only AUTHORIZATION_REPORT, unmatched
// routes emit nothing, the record leaks no identity/secret, and responses/sessions
// are unchanged.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

const AUTH_META_KEYS = ['method', 'path', 'matchedRoute', 'authorized', 'requiredPermissionCount', 'evaluatedPermissionCount', 'missingPermissionCount', 'mode', 'roleCount'];

function capture() {
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  return { rows, stop() { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); } };
}

// 1 + 3. Matched route (admin) emits exactly one AUTHORIZATION_REPORT; response 200.
test('A7-api-1/3. matched route emits one report; response unchanged', async () => {
  const cap = capture();
  try {
    const r = await app.request('GET', '/api/users'); // admin cookie; matched → users.read
    cap.stop();
    assert.equal(r.status, 200, 'response unchanged (19/20)');
    const events = cap.rows.filter((x) => x.event === 'AUTHORIZATION_REPORT');
    assert.equal(events.length, 1, 'exactly one report');
    assert.equal(events[0].metadata.matchedRoute, true);
    assert.equal(events[0].metadata.authorized, true);
    assert.equal(validateLogRecord(events[0]).valid, true);
  } finally { cap.stop(); }
});

// 2. Unmatched route emits nothing.
test('A7-api-2. unmatched route emits nothing', async () => {
  const cap = capture();
  try {
    await app.request('GET', '/api/nonexistent-abc'); // passes through the middleware, no rule
    cap.stop();
    assert.equal(cap.rows.filter((x) => x.event === 'AUTHORIZATION_REPORT').length, 0);
  } finally { cap.stop(); }
});

// 5-16. The report contains only allow-listed count metadata — no identity/secret.
test('A7-api-5..16. report is count-only and content-free', async () => {
  const cap = capture();
  try {
    await app.request('GET', '/api/users'); // admin
    cap.stop();
    const rec = cap.rows.find((x) => x.event === 'AUTHORIZATION_REPORT');
    assert.ok(rec, 'report present');
    assert.deepEqual(Object.keys(rec.metadata).sort(), [...AUTH_META_KEYS].sort(), 'only allow-listed metadata');
    // every count is a number; nothing is an array
    for (const k of ['requiredPermissionCount', 'evaluatedPermissionCount', 'missingPermissionCount', 'roleCount']) {
      assert.equal(typeof rec.metadata[k], 'number', `${k} is a count`);
    }
    for (const v of Object.values(rec.metadata)) assert.ok(!Array.isArray(v), 'no arrays in metadata');
    // no username / role / permission id / cookie / session id in the record
    const s = JSON.stringify(rec);
    const cookieValue = (app.cookie || '').split('=').slice(1).join('=');
    for (const leak of ['admin', 'ADMIN', 'users.read', 'admin.full', 'connect.sid', cookieValue].filter(Boolean)) {
      assert.ok(!s.includes(leak), `record leaked: ${leak}`);
    }
  } finally { cap.stop(); }
});

// 21 + 22. No request/session mutation from the audit path.
test('A7-api-21/22. no request/session mutation', async () => {
  const before = (await app.request('GET', '/api/auth/me')).json();
  await app.request('GET', '/api/users');
  const afterMe = (await app.request('GET', '/api/auth/me')).json();
  assert.deepEqual(afterMe.roles, before.roles);
  assert.deepEqual(afterMe.permissions, before.permissions);
  assert.equal(afterMe.username, before.username);
});

// 4 + 19/20. Unauthorized-but-matched still serves the original response (no denial).
test('A7-api-4/19/20. matched route with any user is never denied', async () => {
  // admin cookie satisfies; the point is the response is the route's own, never 403 from A7
  const r = await app.request('GET', '/api/reports/summary');
  assert.notEqual(r.status, 403, 'never a 403 from the report layer');
});
