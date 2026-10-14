// WP-13 · S4 — Default-admin detection (report-only) tests.
// Drives the real detectDefaultAdmin() against an isolated temp DB (seeded with
// the default admin). Proves it emits ONE safe advisory event when enabled,
// nothing when disabled, never blocks startup, and leaks no password/hash.
require('../helpers/network-guard');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

const ROOT = path.join(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'server.js');

afterEach(() => { delete process.env.ENABLE_DEFAULT_ADMIN_WARNING; });

function captureDetect(app) {
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  return {
    rows,
    stop() { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); },
  };
}

// 1 + 5 + 6. Enabled (default): emits exactly one schema-valid, password-free event.
test('S4-api-1/5/6. default-admin detection emits a safe SECURITY_DEFAULT_CREDENTIAL when enabled', async () => {
  const app = await startTestApp(); // ENABLE_DEFAULT_ADMIN_WARNING default true; temp DB seeded admin/admin123
  const server = require(SERVER_PATH); // this app's instance (bound to its temp DB)
  const cap = captureDetect(app);
  try {
    await server.detectDefaultAdmin();
    cap.stop();
    const events = cap.rows.filter((r) => r.event === 'SECURITY_DEFAULT_CREDENTIAL');
    assert.equal(events.length, 1, 'exactly one advisory event');
    const rec = events[0];
    assert.equal(validateLogRecord(rec).valid, true, 'schema-valid');
    assert.equal(rec.metadata.username, 'admin');
    assert.equal(rec.metadata.severity, 'high');
    assert.equal(typeof rec.metadata.action, 'string');
    assert.equal(typeof rec.metadata.recommendation, 'string');
    // metadata is exactly the allow-listed fields — no password/hash/db path
    assert.deepEqual(Object.keys(rec.metadata).sort(), ['action', 'recommendation', 'severity', 'username'].sort());
    const s = JSON.stringify(rec);
    assert.ok(!s.includes('admin123'), 'no default password in the record');
    assert.ok(!/\$2[aby]\$/.test(s), 'no bcrypt hash in the record');
  } finally { cap.stop(); await app.close(); }
});

// 2. Disabled: emits nothing.
test('S4-api-2. ENABLE_DEFAULT_ADMIN_WARNING=false suppresses the event', async () => {
  process.env.ENABLE_DEFAULT_ADMIN_WARNING = 'false';
  const app = await startTestApp(); // config loads with the flag disabled
  delete process.env.ENABLE_DEFAULT_ADMIN_WARNING;
  const server = require(SERVER_PATH);
  const cap = captureDetect(app);
  try {
    await server.detectDefaultAdmin();
    cap.stop();
    assert.equal(cap.rows.filter((r) => r.event === 'SECURITY_DEFAULT_CREDENTIAL').length, 0, 'no event when disabled');
  } finally { cap.stop(); await app.close(); }
});

// 3 + 4. Startup continues normally; login with admin/admin123 still works.
test('S4-api-3/4. startup continues and admin/admin123 login still works', async () => {
  const app = await startTestApp();
  const server = require(SERVER_PATH);
  try {
    await assert.doesNotReject(() => server.detectDefaultAdmin(), 'detection never throws');
    // fresh (anonymous) login round-trip
    const r = await app.request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, null);
    assert.equal(r.status, 200, 'login unchanged');
    assert.equal(r.json().success, true);
    // app is still serving other routes
    const health = await app.rawRequest(app.baseUrl, 'GET', '/health', null, null);
    assert.equal(health.status, 200, 'app still healthy after detection');
  } finally { await app.close(); }
});

// 7. Detection is idempotent-safe and never mutates the admin account.
test('S4-api-7. detection does not modify the admin account', async () => {
  const app = await startTestApp();
  const server = require(SERVER_PATH);
  try {
    const before = await app.db.dbGet("SELECT UserName, Password, HashPass, UserStatus FROM tblPswd WHERE UserName='admin'");
    await server.detectDefaultAdmin();
    await server.detectDefaultAdmin(); // twice — still no mutation
    const after = await app.db.dbGet("SELECT UserName, Password, HashPass, UserStatus FROM tblPswd WHERE UserName='admin'");
    assert.deepEqual(after, before, 'admin row unchanged by detection');
  } finally { await app.close(); }
});
