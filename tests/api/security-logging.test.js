// WP-13 · S7 — Security logging alignment + generic error response tests.
// Proves the events helpers emit schema-valid, allow-list-filtered SECURITY_*
// records; that S3/S4 still emit their events; and that the opt-in generic 5xx
// body only changes behaviour when GENERIC_ERROR_RESPONSES=true.
require('../helpers/network-guard');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const events = require(path.join(ROOT, 'lib', 'security', 'events.js'));
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const { validateLogRecord } = require(path.join(ROOT, 'lib', 'log-schema.js'));
const SERVER_PATH = path.join(ROOT, 'server.js');

afterEach(() => { delete process.env.GENERIC_ERROR_RESPONSES; delete process.env.RATE_LIMIT_ENFORCE; delete process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS; });

// Capture on the singleton logger (for direct helper tests).
function capture() {
  const rows = [];
  const restoreSink = logger.__setSink((r) => rows.push(r));
  const prevLevel = logger.__setLevel('info');
  return { rows, stop() { logger.__setSink(restoreSink); logger.__setLevel(prevLevel); } };
}

// Raw request with a custom body/headers (harness client always sends valid JSON).
function raw(baseUrl, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + urlPath);
    const payload = body != null ? Buffer.from(body, 'utf8') : null;
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, text: d, json: () => { try { return JSON.parse(d); } catch { return null; } } })); },
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// 1. securityEvent emits a schema-valid record on the Authentication module.
test('S7-1. securityEvent emits a schema-valid record', () => {
  const cap = capture();
  try {
    events.securityEvent('SECURITY_RATE_LIMIT', { path: '/x', method: 'GET', mode: 'report', attempts: 3, limit: 5, enforced: false });
    cap.stop();
    const rec = cap.rows.find((r) => r.event === 'SECURITY_RATE_LIMIT');
    assert.ok(rec, 'record emitted');
    assert.equal(validateLogRecord(rec).valid, true);
    assert.equal(rec.module, 'Authentication');
    assert.equal(rec.metadata.attempts, 3);
  } finally { cap.stop(); }
});

// 2 + 9. Forbidden metadata is discarded before the logger; no secrets leak.
test('S7-2/9. forbidden metadata fields are discarded (allow-list filtering)', () => {
  const cap = capture();
  try {
    events.securityEvent('SECURITY_LOGIN_THROTTLED', {
      username: 'admin', action: 'blocked', // allowed
      password: 'PW-SENTINEL', HashPass: '$2a$10$HASHSENTINEL', hash: 'H',
      cookie: 'connect.sid=SESSENTINEL', authorization: 'Bearer TOKSENTINEL',
      jwt: 'eyJSENT.eyJSENT.SENT', sql: 'SELECT HashPass FROM tblPswd', prompt: 'PROMPT-SENTINEL',
      body: 'BODY-SENTINEL', dbPath: '/db/traintrack.db',
    });
    cap.stop();
    const rec = cap.rows.find((r) => r.event === 'SECURITY_LOGIN_THROTTLED');
    assert.deepEqual(Object.keys(rec.metadata).sort(), ['action', 'username'].sort(), 'only allow-listed keys kept');
    const s = JSON.stringify(rec);
    for (const leak of ['PW-SENTINEL', 'HASHSENTINEL', 'SESSENTINEL', 'TOKSENTINEL', 'eyJSENT', 'SELECT HashPass', 'PROMPT-SENTINEL', 'BODY-SENTINEL', 'traintrack.db']) {
      assert.ok(!s.includes(leak), `leaked: ${leak}`);
    }
  } finally { cap.stop(); }
});

// 3/4/5. Named helpers emit their event names with allow-listed metadata.
test('S7-3/4/5. named helpers emit their SECURITY_* events', () => {
  const cap = capture();
  try {
    events.loginThrottled({ mode: 'report', attempts: 11, limit: 10, enforced: false });
    events.defaultCredential({ username: 'admin', severity: 'high', action: 'x', recommendation: 'change it' });
    events.uploadRejected({ kind: 'document', reason: 'extension', filename: 'evil.exe', mimeType: 'application/x-msdownload', sizeBytes: 123 });
    cap.stop();
    const byEvent = (e) => cap.rows.find((r) => r.event === e);
    assert.ok(byEvent('SECURITY_LOGIN_THROTTLED'));
    assert.ok(byEvent('SECURITY_DEFAULT_CREDENTIAL'));
    const up = byEvent('SECURITY_UPLOAD_REJECTED');
    assert.ok(up);
    assert.equal(up.metadata.kind, 'document');
    assert.equal(up.metadata.filename, 'evil.exe');
    for (const rec of [byEvent('SECURITY_LOGIN_THROTTLED'), byEvent('SECURITY_DEFAULT_CREDENTIAL'), up]) {
      assert.equal(validateLogRecord(rec).valid, true);
    }
  } finally { cap.stop(); }
});

// 6. Helpers never throw even when the logger sink throws.
test('S7-6. helpers never throw when the sink throws', () => {
  const restore = logger.__setSink(() => { throw new Error('sink boom'); });
  const prev = logger.__setLevel('info');
  try {
    assert.doesNotThrow(() => events.securityEvent('SECURITY_RATE_LIMIT', { attempts: 1 }));
    assert.doesNotThrow(() => events.loginThrottled({ attempts: 1 }));
    assert.doesNotThrow(() => events.defaultCredential({ username: 'admin' }));
    assert.doesNotThrow(() => events.uploadRejected({ kind: 'image' }));
    assert.doesNotThrow(() => events.rateLimit({ attempts: 1, limit: 5, enforced: true }));
  } finally { logger.__setSink(restore); logger.__setLevel(prev); }
});

// 7. S3 login throttle still emits SECURITY_LOGIN_THROTTLED (unchanged).
test('S7-7. S3 login throttle still emits SECURITY_LOGIN_THROTTLED', async () => {
  process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS = '3'; // report mode default
  const app = await startTestApp();
  delete process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS;
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  try {
    for (let i = 0; i < 5; i++) await app.request('POST', '/api/auth/login', { username: 'nobody', password: 'x' }, null);
    app.appLogger.__setLevel('silent'); app.appLogger.__resetSink();
    assert.ok(rows.some((r) => r.event === 'SECURITY_LOGIN_THROTTLED'), 'S3 event still emitted');
  } finally { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); }
});

// 8. S4 default-admin detection still emits SECURITY_DEFAULT_CREDENTIAL (via events layer).
test('S7-8. S4 default-admin detection still emits SECURITY_DEFAULT_CREDENTIAL', async () => {
  const app = await startTestApp();
  const server = require(SERVER_PATH);
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  try {
    await server.detectDefaultAdmin();
    app.appLogger.__setLevel('silent'); app.appLogger.__resetSink();
    const rec = rows.find((r) => r.event === 'SECURITY_DEFAULT_CREDENTIAL');
    assert.ok(rec, 'S4 event still emitted');
    assert.equal(rec.module, 'Authentication');
    assert.equal(rec.metadata.username, 'admin');
    assert.equal(validateLogRecord(rec).valid, true);
  } finally { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); }
});

// 10. GENERIC_ERROR_RESPONSES=false (default) preserves the current global 5xx body.
test('S7-10. default preserves the current global 5xx error body', async () => {
  const app = await startTestApp();
  try {
    const r = await raw(app.baseUrl, 'POST', '/api/staff', { headers: { 'Content-Type': 'application/json' }, body: 'not-json{' });
    assert.equal(r.status, 500, 'malformed body → global 500 handler');
    const body = r.json();
    assert.ok(body && typeof body.error === 'string', 'JSON error body');
    assert.notEqual(body.error, 'Internal server error', 'raw (non-generic) message preserved by default');
  } finally { await app.close(); }
});

// 11 + 12. GENERIC_ERROR_RESPONSES=true → generic 5xx body; 4xx unchanged.
test('S7-11/12. generic errors enabled → generic 5xx body; 4xx unchanged', async () => {
  process.env.GENERIC_ERROR_RESPONSES = 'true';
  const app = await startTestApp();
  delete process.env.GENERIC_ERROR_RESPONSES;
  try {
    const r5 = await raw(app.baseUrl, 'POST', '/api/staff', { headers: { 'Content-Type': 'application/json' }, body: 'not-json{' });
    assert.equal(r5.status, 500);
    assert.equal(r5.json().error, 'Internal server error', 'generic 5xx body');
    // a 4xx (bad login) is produced by the route handler → unaffected
    const r4 = await app.request('POST', '/api/auth/login', { username: 'nope', password: 'bad' }, null);
    assert.equal(r4.status, 401);
    assert.equal(r4.json().error, 'Invalid username or password', '4xx body unchanged');
  } finally { await app.close(); }
});
