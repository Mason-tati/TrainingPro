// WP-13 · S1 — Security configuration skeleton tests.
// Proves env resolution rules, safe defaults, immutability, reload semantics, and
// the exact export shape. Infrastructure only — nothing consumes the module yet.
require('../helpers/network-guard');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'lib', 'security', 'config.js');

// Every env var the module reads — cleared before/after each test for isolation.
const SEC_ENV = [
  'SESSION_SECRET', 'SECURE_COOKIES', 'RATE_LIMIT_ENFORCE', 'GENERIC_ERROR_RESPONSES',
  'ENABLE_SECURITY_HEADERS', 'ENABLE_CSP', 'CSP_REPORT_ONLY', 'ENABLE_HSTS',
  'TRUST_PROXY', 'ENABLE_UPLOAD_VALIDATION', 'ENABLE_PASSWORD_POLICY',
  'ENABLE_DEFAULT_ADMIN_WARNING',
  'RATE_LIMIT_LOGIN_MAX_ATTEMPTS', 'RATE_LIMIT_LOGIN_WINDOW_MS', 'RATE_LIMIT_LOGIN_BLOCK_MS',
];
const clearEnv = () => { for (const k of SEC_ENV) delete process.env[k]; };

// Load a FRESH copy of the module (re-resolves env at load time).
function loadFresh() {
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

beforeEach(clearEnv);
afterEach(() => { clearEnv(); delete require.cache[require.resolve(CONFIG_PATH)]; });

const DEFAULT_SECRET = 'traintrack-secret-key-2024';

// ── SESSION_SECRET ──────────────────────────────────────────────────────────
test('S1-1. SESSION_SECRET: env override wins', () => {
  process.env.SESSION_SECRET = 'a-strong-override-secret';
  assert.equal(loadFresh().session.SESSION_SECRET, 'a-strong-override-secret');
});

test('S1-2. SESSION_SECRET: falls back to the current production secret when unset', () => {
  assert.equal(loadFresh().session.SESSION_SECRET, DEFAULT_SECRET);
});

test('S1-3. SESSION_SECRET: blank falls back', () => {
  process.env.SESSION_SECRET = '';
  assert.equal(loadFresh().session.SESSION_SECRET, DEFAULT_SECRET);
});

test('S1-4. SESSION_SECRET: whitespace-only falls back', () => {
  process.env.SESSION_SECRET = '   ';
  assert.equal(loadFresh().session.SESSION_SECRET, DEFAULT_SECRET);
});

// ── Boolean flags ───────────────────────────────────────────────────────────
// Each flag: [env var name, path in the config, default value].
const FLAGS = [
  ['SECURE_COOKIES', (c) => c.cookies.SECURE_COOKIES, false],
  ['RATE_LIMIT_ENFORCE', (c) => c.rateLimit.RATE_LIMIT_ENFORCE, false],
  ['GENERIC_ERROR_RESPONSES', (c) => c.errors.GENERIC_ERROR_RESPONSES, false],
  ['ENABLE_SECURITY_HEADERS', (c) => c.headers.ENABLE_SECURITY_HEADERS, false],
  ['ENABLE_CSP', (c) => c.headers.ENABLE_CSP, false],
  ['CSP_REPORT_ONLY', (c) => c.headers.CSP_REPORT_ONLY, true],
  ['ENABLE_HSTS', (c) => c.headers.ENABLE_HSTS, false],
  ['TRUST_PROXY', (c) => c.proxy.TRUST_PROXY, false],
  ['ENABLE_UPLOAD_VALIDATION', (c) => c.uploads.ENABLE_UPLOAD_VALIDATION, false],
  ['ENABLE_PASSWORD_POLICY', (c) => c.password.ENABLE_PASSWORD_POLICY, false],
  ['ENABLE_DEFAULT_ADMIN_WARNING', (c) => c.admin.ENABLE_DEFAULT_ADMIN_WARNING, true],
];
// Non-"true" values that MUST all resolve to false.
const FALSE_VALUES = ['false', '', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on', 'enabled', 'null'];

for (const [name, get, dflt] of FLAGS) {
  test(`S1-flag. ${name}: default is ${dflt}`, () => {
    clearEnv();
    assert.equal(get(loadFresh()), dflt, 'default when unset');
  });

  test(`S1-flag. ${name}: only exact "true" enables; all other values are false`, () => {
    process.env[name] = 'true';
    assert.equal(get(loadFresh()), true, 'exact "true" → true');
    for (const v of FALSE_VALUES) {
      process.env[name] = v;
      assert.equal(get(loadFresh()), false, `"${v}" → false`);
    }
  });
}

// ── Frozen object ───────────────────────────────────────────────────────────
test('S1-frozen. root and nested objects are frozen (no add/replace/mutate)', () => {
  const c = loadFresh();
  assert.ok(Object.isFrozen(c), 'root frozen');
  for (const group of Object.keys(c)) assert.ok(Object.isFrozen(c[group]), `${group} frozen`);

  // cannot add
  try { c.injected = 1; } catch { /* strict throw ok */ }
  assert.equal(c.injected, undefined, 'cannot add root property');
  // cannot replace a group
  const originalSession = c.session;
  try { c.session = {}; } catch { /* strict throw ok */ }
  assert.equal(c.session, originalSession, 'cannot replace a group');
  // cannot mutate a nested value
  try { c.cookies.SECURE_COOKIES = true; } catch { /* strict throw ok */ }
  assert.equal(c.cookies.SECURE_COOKIES, false, 'cannot mutate nested value');
  try { c.session.SESSION_SECRET = 'hacked'; } catch { /* strict throw ok */ }
  assert.equal(c.session.SESSION_SECRET, DEFAULT_SECRET, 'nested secret intact');
});

// ── Module reload ───────────────────────────────────────────────────────────
test('S1-reload. changing env + clearing the require cache yields new values', () => {
  const before = loadFresh();
  assert.equal(before.cookies.SECURE_COOKIES, false);
  process.env.SECURE_COOKIES = 'true';
  process.env.SESSION_SECRET = 'reloaded-secret';
  const after = loadFresh();
  assert.equal(after.cookies.SECURE_COOKIES, true, 'flag re-resolved after reload');
  assert.equal(after.session.SESSION_SECRET, 'reloaded-secret', 'secret re-resolved after reload');
  assert.notEqual(before, after, 'a new frozen object is produced');
});

// ── Export shape ────────────────────────────────────────────────────────────
test('S1-shape. exactly the expected keys; no helpers/accidental exports', () => {
  const c = loadFresh();
  assert.deepEqual(
    Object.keys(c).sort(),
    ['admin', 'cookies', 'errors', 'headers', 'password', 'proxy', 'rateLimit', 'session', 'uploads'].sort(),
  );
  assert.deepEqual(Object.keys(c.session), ['SESSION_SECRET']);
  assert.deepEqual(Object.keys(c.headers).sort(), ['CSP_REPORT_ONLY', 'ENABLE_CSP', 'ENABLE_HSTS', 'ENABLE_SECURITY_HEADERS'].sort());
  // no internal helpers leaked onto the export
  assert.equal(typeof c.boolEnv, 'undefined', 'boolEnv not exported');
  assert.equal(typeof c.stringEnv, 'undefined', 'stringEnv not exported');
  // every leaf is a boolean, number, or the secret string — no functions anywhere
  for (const group of Object.values(c)) {
    for (const v of Object.values(group)) {
      assert.ok(['boolean', 'number', 'string'].includes(typeof v), 'leaf is boolean/number/string');
    }
  }
});

// ── S3 — rate-limit numeric settings ────────────────────────────────────────
test('S3-cfg. rate-limit numeric defaults and overrides resolve safely', () => {
  clearEnv();
  const d = loadFresh().rateLimit;
  assert.equal(d.RATE_LIMIT_ENFORCE, false, 'enforce default false');
  assert.equal(d.RATE_LIMIT_LOGIN_MAX_ATTEMPTS, 10);
  assert.equal(d.RATE_LIMIT_LOGIN_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(d.RATE_LIMIT_LOGIN_BLOCK_MS, 15 * 60 * 1000);

  process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS = '3';
  process.env.RATE_LIMIT_LOGIN_WINDOW_MS = '5000';
  process.env.RATE_LIMIT_LOGIN_BLOCK_MS = '9000';
  const o = loadFresh().rateLimit;
  assert.equal(o.RATE_LIMIT_LOGIN_MAX_ATTEMPTS, 3);
  assert.equal(o.RATE_LIMIT_LOGIN_WINDOW_MS, 5000);
  assert.equal(o.RATE_LIMIT_LOGIN_BLOCK_MS, 9000);

  // invalid / blank / ≤0 / non-integer → safe defaults
  for (const bad of ['', '   ', 'abc', '0', '-5', '3.5', 'NaN']) {
    process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS = bad;
    assert.equal(loadFresh().rateLimit.RATE_LIMIT_LOGIN_MAX_ATTEMPTS, 10, `"${bad}" → default 10`);
  }
});

// ── No network (guard active) ───────────────────────────────────────────────
test('S1-net. no network occurs', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true);
});
