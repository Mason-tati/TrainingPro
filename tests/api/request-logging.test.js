// WP-08 · L3 — request/response lifecycle logging tests.
// Isolated harness; the app's fresh logger instance is captured via a test sink.
// No bodies are ever logged; every record must pass validateLogRecord().
require('../helpers/network-guard');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

let app;
let logs;
let rcFresh; // the SAME fresh request-context instance the app logger uses

before(async () => {
  app = await startTestApp();
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((rec) => logs.push(rec));
  rcFresh = require(path.join(__dirname, '..', '..', 'lib', 'request-context.js'));
});
after(async () => { if (app) { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); } });
beforeEach(() => { logs = []; });

function rawReq(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(app.baseUrl + urlPath);
    const payload = body != null ? Buffer.from(body, 'utf8') : null;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { ...(payload ? { 'Content-Length': payload.length } : {}), ...headers } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: d })); }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const eventsFor = (p, ev) => logs.filter((r) => r.metadata && r.metadata.path === p && (!ev || r.event === ev));
const settle = () => new Promise((r) => setTimeout(r, 25)); // let 'finish' listeners run

// 1/2/3/6/18. Normal request → START + COMPLETE, same requestId, duration ≥ 0, correct status, exactly once.
test('1-3/6/18. normal request emits START and COMPLETE with shared requestId', async () => {
  const r = await rawReq('GET', '/api/auth/me', { headers: { 'X-Request-Id': 'l3-fixed-1' } });
  await settle();
  assert.equal(r.status, 401); // unauthenticated /me — existing behaviour
  const starts = eventsFor('/api/auth/me', 'HTTP_REQUEST_START');
  const completes = eventsFor('/api/auth/me', 'HTTP_REQUEST_COMPLETE');
  assert.equal(starts.length, 1, 'exactly one START');
  assert.equal(completes.length, 1, 'exactly one COMPLETE');
  assert.equal(starts[0].requestId, 'l3-fixed-1');
  assert.equal(completes[0].requestId, 'l3-fixed-1', 'same requestId in both records');
  assert.equal(starts[0].message, 'Incoming HTTP request');
  assert.equal(completes[0].message, 'HTTP request completed');
  assert.equal(completes[0].metadata.statusCode, 401, 'status recorded');
  assert.ok(Number.isFinite(completes[0].metadata.durationMs) && completes[0].metadata.durationMs >= 0, 'duration >= 0');
  assert.equal(starts[0].metadata.method, 'GET');
});

// 4. Anonymous actor before authentication.
test('4. actor is anonymous before authentication', async () => {
  await rawReq('GET', '/api/auth/me', {});
  await settle();
  for (const rec of logs) assert.equal(rec.actor, 'anonymous');
});

// 5. Authenticated actor after context.set() (inside test only).
test('5. context.set(actor) is reflected in subsequent records', () => {
  rcFresh.run({ requestId: 'l3-ctx', actor: 'anonymous', tenantId: null, module: 'System' }, () => {
    rcFresh.set('actor', 'admin');
    app.appLogger.info('probe.event', { message: 'after set' });
  });
  const rec = logs.find((r) => r.event === 'probe.event');
  assert.equal(rec.actor, 'admin');
  assert.equal(rec.requestId, 'l3-ctx');
});

// 7. 404 requests are logged.
test('7. 404 API requests are logged with statusCode 404', async () => {
  await rawReq('POST', '/api/nonexistent-route', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await settle();
  const complete = eventsFor('/api/nonexistent-route', 'HTTP_REQUEST_COMPLETE')[0];
  assert.ok(complete, 'completion logged');
  assert.equal(complete.metadata.statusCode, 404);
});

// 8. 500 errors are logged (Express error path → HTTP_REQUEST_ERROR + COMPLETE 500).
test('8. errors emit HTTP_REQUEST_ERROR with masked message and no stack', async () => {
  const r = await rawReq('POST', '/api/auth/login', { headers: { 'Content-Type': 'application/json' }, body: '{malformed json' });
  await settle();
  assert.equal(r.status, 500, 'error handler responded (existing contract)');
  const errs = eventsFor('/api/auth/login', 'HTTP_REQUEST_ERROR');
  assert.equal(errs.length, 1, 'one error event');
  assert.equal(errs[0].level, 'ERROR');
  assert.equal(typeof errs[0].metadata.errorName, 'string');
  assert.equal(typeof errs[0].metadata.maskedErrorMessage, 'string');
  assert.ok(!('stack' in errs[0].metadata), 'no stack');
  const completes = eventsFor('/api/auth/login', 'HTTP_REQUEST_COMPLETE');
  assert.equal(completes.length, 1);
  assert.equal(completes[0].metadata.statusCode, 500);
});

// 9/10. /health and /favicon.ico are skipped entirely.
test('9/10. /health and /favicon.ico emit no log events', async () => {
  await rawReq('GET', '/health', {});
  await rawReq('GET', '/favicon.ico', {});
  await settle();
  assert.equal(eventsFor('/health').length, 0);
  assert.equal(eventsFor('/favicon.ico').length, 0);
});

// 11. Successful static asset requests are skipped.
test('11. successful static asset requests are not logged', async () => {
  const r = await rawReq('GET', '/css/style.css', {});
  await settle();
  assert.equal(r.status, 200, 'asset served');
  assert.equal(eventsFor('/css/style.css').length, 0, 'no events for successful static asset');
});

// 12. Static asset failures are still logged.
test('12. failed static asset requests are logged', async () => {
  const r = await rawReq('POST', '/broken-asset.png', {}); // no POST route → 404
  await settle();
  assert.equal(r.status, 404);
  const completes = eventsFor('/broken-asset.png', 'HTTP_REQUEST_COMPLETE');
  assert.equal(completes.length, 1, 'failure logged');
  assert.equal(completes[0].metadata.statusCode, 404);
});

// 13. Logger failures never affect responses.
test('13. a throwing sink does not affect the response', async () => {
  app.appLogger.__setSink(() => { throw new Error('sink boom'); });
  const r = await rawReq('GET', '/api/auth/me', {});
  assert.equal(r.status, 401, 'response unaffected by sink failure');
  app.appLogger.__setSink((rec) => logs.push(rec)); // restore
});

// 14/15/17. No request/response bodies in logs; redaction applies to metadata.
test('14/15/17. bodies never appear in logs; sensitive values are redacted', async () => {
  const secret = 'SuperSecretPassword-98765';
  await rawReq('POST', '/api/auth/login', {
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'agent-of a.person@example.com' },
    body: JSON.stringify({ username: 'admin', password: secret }),
  });
  await settle();
  const all = JSON.stringify(logs);
  assert.ok(!all.includes(secret), 'request-body password value never logged');
  assert.ok(!all.includes('Invalid username'), 'response body content never logged');
  assert.ok(!all.includes('a.person@example.com'), 'email in header masked by redactor');
  const start = eventsFor('/api/auth/login', 'HTTP_REQUEST_START')[0];
  assert.ok(start.metadata.userAgent.includes('a***@example.com'), 'masked userAgent retained');
});

// 16. Every emitted record passes validateLogRecord().
test('16. every emitted record is schema-valid', async () => {
  await rawReq('GET', '/api/auth/me', {});
  await rawReq('POST', '/api/nonexistent', { headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await settle();
  assert.ok(logs.length >= 3, 'events captured');
  for (const rec of logs) {
    const res = validateLogRecord(rec);
    assert.equal(res.valid, true, `${rec.event}: ${res.errors.join(',')}`);
  }
});

// WP-08 L7 — FINAL LOGGING SAFETY SWEEP. Drives representative traffic carrying
// every category of forbidden material through the app (bodies, credentials,
// medical/disciplinary text, SQL-shaped input, AI-style fields), including error
// paths, then asserts none of it appears in ANY captured log record.
test('L7 sweep: no forbidden material appears in any captured log', async () => {
  const FORBIDDEN = {
    password: 'Sweep-P@ssw0rd-77xx',
    hashPass: '$2a$10$sweepHashValue123456',
    bearer: 'Bearer sweep-bearer-token-abc123',
    apiKey: 'sk-ant-sweep1234567890',
    prompt: 'SWEEP-PROMPT: translate this document',
    completion: 'SWEEP-COMPLETION: model output text',
    aiOutput: 'SWEEP-RAW-AI-OUTPUT payload',
    sql: "SELECT HashPass FROM tblPswd WHERE UserName='admin'",
    sqlParam: 'sweep-sql-param-value',
    medical: 'SWEEP-MEDICAL: asthma diagnosis, fit for work with restrictions',
    disciplinary: 'SWEEP-DISCIPLINARY: verbal warning for absenteeism',
    responseBody: 'Invalid username or password', // known response text
  };

  // 1. Failed login with the sweep password (request body + response body).
  await rawReq('POST', '/api/auth/login', {
    headers: { 'Content-Type': 'application/json', Authorization: FORBIDDEN.bearer },
    body: JSON.stringify({ username: 'admin', password: FORBIDDEN.password }),
  });
  // 2. Staff create carrying medical/disciplinary-like text + SQL-shaped + AI-style fields (authenticated).
  const staffRes = await new Promise((resolve, reject) => {
    const u = new URL(app.baseUrl + '/api/staff');
    const payload = Buffer.from(JSON.stringify({
      LastName: 'Sweep', FirstName: 'Test', Status: 'Active', FileNum: 'L7-SWEEP',
      Note: FORBIDDEN.medical + ' | ' + FORBIDDEN.disciplinary,
      Other: FORBIDDEN.sql, SS: '987654321', DOB: '1990-02-02',
      prompt: FORBIDDEN.prompt, completion: FORBIDDEN.completion, aiOutput: FORBIDDEN.aiOutput,
      HashPass: FORBIDDEN.hashPass, apiKey: FORBIDDEN.apiKey,
    }), 'utf8');
    const req2 = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: app.cookie, 'Content-Length': payload.length } },
      (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, text: d })); }
    );
    req2.on('error', reject);
    req2.write(payload);
    req2.end();
  });
  assert.equal(staffRes.status, 200, 'sweep staff record created');
  // 3. Error path (route-caught 500 via FK violation) with a SQL-param-like value.
  await rawReq('POST', '/api/staff/999999/notes', {
    headers: { 'Content-Type': 'application/json', Cookie: app.cookie },
    body: JSON.stringify({ Note: FORBIDDEN.sqlParam }),
  });
  // 4. Uncaught error path (malformed JSON → error handler).
  await rawReq('POST', '/api/auth/login', { headers: { 'Content-Type': 'application/json' }, body: '{sweep-malformed' });
  await settle();

  const all = JSON.stringify(logs);
  assert.ok(logs.length >= 6, 'sweep traffic produced log records');
  for (const [label, value] of Object.entries(FORBIDDEN)) {
    assert.ok(!all.includes(value), `forbidden ${label} never appears in logs`);
  }
  assert.ok(!all.includes(app.cookie.split('=')[1] || '@@none@@'), 'session id value never appears');
  assert.ok(!all.includes('987654321'), 'SSN-like value never appears');
  assert.ok(!/SELECT |INSERT INTO |UPDATE .* SET /i.test(all), 'no SQL statements in logs');
});

// 19/20. Parallel requests keep unique requestIds; no duplicate events.
test('19/20. parallel requests have unique ids and exactly one START+COMPLETE each', async () => {
  await Promise.all([
    rawReq('GET', '/api/auth/me', {}),
    rawReq('GET', '/api/auth/me', {}),
    rawReq('GET', '/api/auth/me', {}),
  ]);
  await settle();
  const starts = eventsFor('/api/auth/me', 'HTTP_REQUEST_START');
  const completes = eventsFor('/api/auth/me', 'HTTP_REQUEST_COMPLETE');
  assert.equal(starts.length, 3, 'three STARTs');
  assert.equal(completes.length, 3, 'three COMPLETEs');
  const ids = starts.map((r) => r.requestId);
  assert.equal(new Set(ids).size, 3, 'unique requestIds');
  for (const id of ids) {
    assert.equal(completes.filter((c) => c.requestId === id).length, 1, 'one COMPLETE per id');
  }
});
