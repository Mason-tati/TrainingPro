// WP-13 · S3 — Login rate limiting tests.
// Drives the real POST /api/auth/login through the real app (temp DB + temp
// session store). Proves report-only default never blocks, enforce mode blocks
// with 429 without reaching the handler, per-key isolation, clock-driven reset,
// fail-open, and that throttle logs carry no identity/secret values.
require('../helpers/network-guard');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

const ROOT = path.join(__dirname, '..', '..');
const RL_PATH = path.join(ROOT, 'lib', 'security', 'rate-limit.js');

const RL_ENV = ['RATE_LIMIT_ENFORCE', 'RATE_LIMIT_LOGIN_MAX_ATTEMPTS', 'RATE_LIMIT_LOGIN_WINDOW_MS', 'RATE_LIMIT_LOGIN_BLOCK_MS'];
const clearRl = () => { for (const k of RL_ENV) delete process.env[k]; };
afterEach(clearRl);

// Start a fresh isolated app with the given rate-limit env (config resolves at
// load; the harness purges lib/** so each start rebuilds config + the limiter).
async function startApp(env = {}) {
  clearRl();
  Object.assign(process.env, env);
  const app = await startTestApp();
  clearRl(); // config already captured — don't leak into other starts
  return app;
}
const badLogin = (app, username) => app.request('POST', '/api/auth/login', { username, password: 'wrong-pw' });
const EXPECTED_META_KEYS = ['attempts', 'blockMs', 'enforced', 'limit', 'method', 'mode', 'path', 'status', 'windowMs'];

// 1/2. Report-only default never blocks — success works; many failures stay 401.
test('S3-1/2. report-only default: success works and repeated failures are never blocked', async () => {
  const app = await startApp(); // defaults: report mode, max 10
  try {
    for (let i = 0; i < 12; i++) { // > default max → throttle would trip, but report never blocks
      const r = await badLogin(app, 'nobody');
      assert.equal(r.status, 401, `attempt ${i + 1} stays 401 (never 429)`);
    }
    const ok = await app.request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
    assert.equal(ok.status, 200, 'successful login unchanged');
    assert.equal(ok.json().success, true);
  } finally { await app.close(); }
});

// 3 + 9-12. Report-only emits SECURITY_LOGIN_THROTTLED after threshold; logs are safe.
test('S3-3/9-12. report-only emits a metadata-only throttle event; no identity/secret in logs', async () => {
  const app = await startApp({ RATE_LIMIT_LOGIN_MAX_ATTEMPTS: '3' }); // report, low threshold
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  try {
    for (let i = 0; i < 5; i++) {
      const r = await app.request('POST', '/api/auth/login', { username: 'LEAKUSER-SENTINEL', password: 'LEAKPASS-SENTINEL' });
      assert.notEqual(r.status, 429, 'report mode never blocks');
    }
    const events = rows.filter((r) => r.event === 'SECURITY_LOGIN_THROTTLED');
    assert.ok(events.length >= 1, 'throttle event emitted after the threshold');
    const rec = events[0];
    assert.equal(validateLogRecord(rec).valid, true, 'throttle record schema-valid');
    assert.equal(rec.metadata.mode, 'report');
    assert.equal(rec.metadata.enforced, false);
    assert.equal(rec.metadata.limit, 3);
    assert.equal(rec.metadata.path, '/api/auth/login');
    assert.equal(rec.metadata.method, 'POST');
    assert.equal(typeof rec.metadata.attempts, 'number');
    // metadata is EXACTLY the allow-listed operational fields — no username/ip/cookie/etc.
    assert.deepEqual(Object.keys(rec.metadata).sort(), [...EXPECTED_META_KEYS].sort());
    // no username / password sentinel anywhere in the throttle records
    const s = JSON.stringify(events);
    for (const leak of ['LEAKUSER-SENTINEL', 'LEAKPASS-SENTINEL']) assert.ok(!s.includes(leak), `throttle log leaked ${leak}`);
    // no cookie / session / bearer / authorization tokens
    assert.ok(!/connect\.sid|authorization|bearer|set-cookie/i.test(s), 'no session/cookie/auth token in logs');
  } finally { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); }
});

// 4/5. Enforce mode returns 429 after threshold, without reaching the login handler.
test('S3-4/5. enforce mode blocks with 429 after threshold and bypasses the handler', async () => {
  const app = await startApp({ RATE_LIMIT_ENFORCE: 'true', RATE_LIMIT_LOGIN_MAX_ATTEMPTS: '3', RATE_LIMIT_LOGIN_BLOCK_MS: '60000' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await badLogin(app, 'attacker')).status, 401, 'under threshold → normal 401');
    const blocked = await badLogin(app, 'attacker');
    assert.equal(blocked.status, 429, 'over threshold → 429');
    assert.equal(blocked.json().error, 'Too many login attempts. Please try again later.');
    // 429 (never 401/200) proves the auth handler was NOT reached — the route has no 429 path.
  } finally { await app.close(); }
});

// 6. Enforce mode allows attempts again after the block window elapses (deterministic clock).
test('S3-6. enforce mode releases the block after the window using the test clock', async () => {
  const app = await startApp({ RATE_LIMIT_ENFORCE: 'true', RATE_LIMIT_LOGIN_MAX_ATTEMPTS: '3', RATE_LIMIT_LOGIN_BLOCK_MS: '1000' });
  const rl = require(RL_PATH); // this app's limiter instance
  const base = 1_000_000;
  rl.__setClock(() => base);
  try {
    for (let i = 0; i < 3; i++) assert.equal((await badLogin(app, 'u6')).status, 401);
    assert.equal((await badLogin(app, 'u6')).status, 429, 'blocked at threshold');
    rl.__setClock(() => base + 2000); // advance past blockMs
    assert.equal((await badLogin(app, 'u6')).status, 401, 'block released → back to normal 401');
  } finally { rl.__setClock(null); rl.__reset(); await app.close(); }
});

// 7. Per-key isolation — throttling one key does not affect a different key.
test('S3-7. per-key isolation between distinct login keys', async () => {
  const app = await startApp({ RATE_LIMIT_ENFORCE: 'true', RATE_LIMIT_LOGIN_MAX_ATTEMPTS: '3', RATE_LIMIT_LOGIN_BLOCK_MS: '60000' });
  const rl = require(RL_PATH);
  try {
    for (let i = 0; i < 4; i++) await badLogin(app, 'keyA');
    assert.equal((await badLogin(app, 'keyA')).status, 429, 'keyA is blocked');
    assert.equal((await badLogin(app, 'keyB')).status, 401, 'keyB is unaffected');
    // distinct keys are tracked independently (opaque state; no identity values)
    const st = rl.__getState();
    assert.ok(st.size >= 2, 'at least two independent keys tracked');
    assert.ok(st.entries.every((e) => typeof e.count === 'number'), 'state entries are opaque counters');
  } finally { rl.__reset(); await app.close(); }
});

// 8. Limiter fails OPEN on an internal error (never throws, always calls next()).
test('S3-8. limiter fails open on internal error', () => {
  const rl = require(RL_PATH);
  const mw = rl.createLoginRateLimiter({}); // no rateLimit group → internal throw path
  let nexted = false;
  const res = { status() { return this; }, json() { return this; } };
  assert.doesNotThrow(() => mw({ body: {} }, res, () => { nexted = true; }));
  assert.equal(nexted, true, 'next() called despite the internal error');
});
