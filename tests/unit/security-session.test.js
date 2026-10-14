// WP-13 · S2 — Session & cookie hardening tests.
// Verifies that server.js builds its express-session options and trust-proxy
// setting from the S1 security config, that the DEFAULT config reproduces the
// pre-S2 behaviour exactly, and that overrides flow through. The two helpers are
// pure; server.js is required under temp DB/session paths so no production DB or
// session store is ever touched (initDb is lazy — only start() opens the DB).
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const TMP = path.join(ROOT, 'tests', '.tmp');
fs.mkdirSync(TMP, { recursive: true });

// Isolate any side effects to temp locations BEFORE requiring server.js, and
// clear the S2 env so the real security config resolves to its defaults.
process.env.DATABASE_PATH = path.join(TMP, `s2-${process.pid}.db`);
process.env.SESSION_DB_DIR = TMP;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
for (const k of ['SESSION_SECRET', 'SECURE_COOKIES', 'TRUST_PROXY']) delete process.env[k];

require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionOptions, applyTrustProxy } = require(path.join(ROOT, 'server.js'));
const securityConfig = require(path.join(ROOT, 'lib', 'security', 'config.js'));

const DEFAULT_SECRET = 'traintrack-secret-key-2024';
const EIGHT_HOURS = 8 * 60 * 60 * 1000;
const STORE = { __store: 'sentinel' }; // stand-in session store (passed through by reference)

// Build a synthetic config-shaped object for override tests.
const cfg = (o = {}) => ({
  session: { SESSION_SECRET: o.secret !== undefined ? o.secret : DEFAULT_SECRET },
  cookies: { SECURE_COOKIES: o.secure !== undefined ? o.secure : false },
  proxy: { TRUST_PROXY: o.trustProxy !== undefined ? o.trustProxy : false },
});
const fakeApp = () => { const calls = []; return { calls, set: (k, v) => calls.push([k, v]) }; };

// ── Default behaviour ───────────────────────────────────────────────────────
test('S2-1. default: SESSION_SECRET resolves to the current production secret', () => {
  assert.equal(securityConfig.session.SESSION_SECRET, DEFAULT_SECRET);
  assert.equal(buildSessionOptions(securityConfig, STORE).secret, DEFAULT_SECRET);
});

test('S2-2. default: cookie.secure is false', () => {
  assert.equal(securityConfig.cookies.SECURE_COOKIES, false);
  assert.equal(buildSessionOptions(securityConfig, STORE).cookie.secure, false);
});

test('S2-3. default: trust proxy is disabled (app.set not called)', () => {
  assert.equal(securityConfig.proxy.TRUST_PROXY, false);
  const app = fakeApp();
  applyTrustProxy(app, securityConfig);
  assert.equal(app.calls.length, 0, 'app.set never called by default');
});

// ── Config override ─────────────────────────────────────────────────────────
test('S2-4. override: SESSION_SECRET flows through', () => {
  assert.equal(buildSessionOptions(cfg({ secret: 'a-new-secret' }), STORE).secret, 'a-new-secret');
});

test('S2-5. override: SECURE_COOKIES=true → cookie.secure true', () => {
  assert.equal(buildSessionOptions(cfg({ secure: true }), STORE).cookie.secure, true);
});

test('S2-6. override: TRUST_PROXY=true → app.set("trust proxy", 1) exactly once', () => {
  const app = fakeApp();
  applyTrustProxy(app, cfg({ trustProxy: true }));
  assert.deepEqual(app.calls, [['trust proxy', 1]]);
});

// ── Behaviour preservation ──────────────────────────────────────────────────
test('S2-7. default config produces exactly the pre-S2 session options object', () => {
  const opts = buildSessionOptions(cfg(), STORE);
  assert.deepEqual(opts, {
    store: STORE,
    secret: DEFAULT_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: EIGHT_HOURS, secure: false },
  });
  // secure:false is behaviourally identical to the previous (omitted) cookie.secure.
});

test('S2-8. no unexpected option changes (exact key sets; unchanged constants)', () => {
  const opts = buildSessionOptions(securityConfig, STORE);
  assert.deepEqual(Object.keys(opts).sort(), ['cookie', 'resave', 'saveUninitialized', 'secret', 'store'].sort());
  assert.deepEqual(Object.keys(opts.cookie).sort(), ['maxAge', 'secure'].sort());
  assert.equal(opts.resave, false);
  assert.equal(opts.saveUninitialized, false);
  assert.equal(opts.cookie.maxAge, EIGHT_HOURS);
  assert.equal(opts.store, STORE, 'store passed through by reference');
});

// ── Trust proxy: only when enabled ──────────────────────────────────────────
test('S2-9. trust proxy: applied only when enabled', () => {
  const off = fakeApp();
  applyTrustProxy(off, cfg({ trustProxy: false }));
  assert.equal(off.calls.length, 0, 'no call when disabled');
  const on = fakeApp();
  applyTrustProxy(on, cfg({ trustProxy: true }));
  assert.deepEqual(on.calls, [['trust proxy', 1]], 'exactly one call when enabled');
});

// ── Cookie secure: default false, true only when enabled ────────────────────
test('S2-10. cookie.secure: false by default, true only when enabled', () => {
  assert.equal(buildSessionOptions(cfg({ secure: false }), STORE).cookie.secure, false);
  assert.equal(buildSessionOptions(cfg({ secure: true }), STORE).cookie.secure, true);
});

// ── No network (guard active) ───────────────────────────────────────────────
test('S2-11. no network occurs', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true);
});
