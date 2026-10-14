// WP-13 · S8 — Final security safety sweep.
// End-to-end proof that, with all security env unset, WP-13 is behaviour-neutral:
// defaults are off, auth/session/password-change are unchanged, security logs
// carry no sensitive data, the S6 modules are unwired, and production DBs are
// untouched. Uses an isolated temp DB/session.
require('../helpers/network-guard');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'lib', 'security', 'config.js');
const EVENTS_PATH = path.join(ROOT, 'lib', 'security', 'events.js');
const SERVER_PATH = path.join(ROOT, 'server.js');

// Every security env var — cleared so the sweep runs against pure defaults.
const SEC_ENV = [
  'SESSION_SECRET', 'SECURE_COOKIES', 'TRUST_PROXY', 'RATE_LIMIT_ENFORCE',
  'RATE_LIMIT_LOGIN_MAX_ATTEMPTS', 'RATE_LIMIT_LOGIN_WINDOW_MS', 'RATE_LIMIT_LOGIN_BLOCK_MS',
  'ENABLE_SECURITY_HEADERS', 'ENABLE_CSP', 'CSP_REPORT_ONLY', 'ENABLE_HSTS',
  'ENABLE_UPLOAD_VALIDATION', 'ENABLE_PASSWORD_POLICY', 'ENABLE_DEFAULT_ADMIN_WARNING',
  'GENERIC_ERROR_RESPONSES',
];
const clearEnv = () => { for (const k of SEC_ENV) delete process.env[k]; };
afterEach(clearEnv);

function loadFreshConfig() {
  clearEnv();
  delete require.cache[require.resolve(CONFIG_PATH)];
  return require(CONFIG_PATH);
}

// 1 + 5-9. Default security config is entirely OFF (behaviour-preserving).
test('S8-sweep-1/5-9. all security defaults are off', () => {
  const c = loadFreshConfig();
  assert.equal(c.cookies.SECURE_COOKIES, false, 'secure cookies off (5)');
  assert.equal(c.proxy.TRUST_PROXY, false, 'trust proxy off (6)');
  assert.equal(c.headers.ENABLE_SECURITY_HEADERS, false, 'security headers off (7)');
  assert.equal(c.headers.ENABLE_HSTS, false, 'HSTS off');
  assert.equal(c.headers.ENABLE_CSP, false, 'CSP off');
  assert.equal(c.rateLimit.RATE_LIMIT_ENFORCE, false, 'rate-limit enforcement off (8)');
  assert.equal(c.errors.GENERIC_ERROR_RESPONSES, false, 'generic errors off (9)');
  assert.equal(c.session.SESSION_SECRET, 'traintrack-secret-key-2024', 'session secret default unchanged');
});

// 2 + 3 + 4 + 5 + 7 + 8. Live default app: auth works, no security headers, no
// secure cookie, no rate-limit block, password change unchanged.
test('S8-sweep-2/3/4/7/8. default app: auth/session/password-change unchanged', async () => {
  clearEnv();
  const app = await startTestApp();
  try {
    // 2. login success
    const ok = await app.request('POST', '/api/auth/login', { username: 'admin', password: 'admin123' }, null);
    assert.equal(ok.status, 200, 'login success (2)');
    const setCookie = (ok.headers['set-cookie'] || []).join(';');
    assert.ok(!/;\s*Secure/i.test(setCookie), 'session cookie not Secure by default (5)');
    const cookie = setCookie.split(';')[0];

    // 3. login failure
    assert.equal((await app.request('POST', '/api/auth/login', { username: 'admin', password: 'nope' }, null)).status, 401, 'login failure (3)');

    // 7. no security headers on a normal response
    const health = await app.rawRequest(app.baseUrl, 'GET', '/health', null, null);
    for (const hdr of ['x-content-type-options', 'x-frame-options', 'strict-transport-security', 'content-security-policy', 'content-security-policy-report-only']) {
      assert.equal(health.headers[hdr], undefined, `${hdr} absent by default (7)`);
    }

    // 8. repeated failures never blocked (report-only default)
    for (let i = 0; i < 12; i++) assert.notEqual((await app.request('POST', '/api/auth/login', { username: 'x', password: 'y' }, null)).status, 429, 'no 429 by default (8)');

    // 4. password change still works (advisory policy does NOT block, even a weak pw)
    const chg = await app.request('POST', '/api/auth/change-password', { oldPassword: 'admin123', newPassword: 'weak' }, cookie);
    assert.equal(chg.status, 200, 'password change unchanged (4)');
    assert.equal(chg.json().success, true);
  } finally { await app.close(); }
});

// 10-15. Security logs never contain sensitive values.
test('S8-sweep-10-15. no sensitive data in security logs', async () => {
  process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS = '3';
  const app = await startTestApp();
  delete process.env.RATE_LIMIT_LOGIN_MAX_ATTEMPTS;
  const events = require(EVENTS_PATH);   // this app's events instance → this app's logger
  const server = require(SERVER_PATH);
  const rows = [];
  app.appLogger.__setLevel('info');
  app.appLogger.__setSink((r) => rows.push(r));
  try {
    // trigger a throttle event (S3) with sentinel credentials
    for (let i = 0; i < 5; i++) await app.request('POST', '/api/auth/login', { username: 'SWEEP-USER-SENTINEL', password: 'SWEEP-PASS-SENTINEL' }, null);
    // default-admin advisory (S4)
    await server.detectDefaultAdmin();
    // a security event with every forbidden field stuffed with sentinels
    events.securityEvent('SECURITY_LOGIN_THROTTLED', {
      username: 'admin', action: 'sweep',
      password: 'PW-SENTINEL', HashPass: '$2a$10$HASHSENTINEL', cookie: 'connect.sid=SESSIONSENTINEL',
      authorization: 'Bearer TOKENSENTINEL', jwt: 'eyJSENT.eyJSENT.SENT', body: 'BODY-SENTINEL',
      sql: 'SELECT HashPass FROM tblPswd', dbPath: 'database/traintrack.db',
    });
    app.appLogger.__setLevel('silent'); app.appLogger.__resetSink();

    const security = rows.filter((r) => typeof r.event === 'string' && r.event.startsWith('SECURITY_'));
    assert.ok(security.length >= 1, 'security events captured');
    const s = JSON.stringify(security);
    const loginCookieValue = (app.cookie || '').split('=').slice(1).join('=');
    const forbidden = [
      'SWEEP-USER-SENTINEL', 'SWEEP-PASS-SENTINEL', // 10 (password) / raw username
      'PW-SENTINEL', 'HASHSENTINEL',                // 10 password / hash
      'SESSIONSENTINEL',                            // 11 session id
      'connect.sid=', loginCookieValue,             // 12 cookie
      'Bearer TOKENSENTINEL', 'TOKENSENTINEL', 'eyJSENT', // 13 authorization/bearer/jwt
      'BODY-SENTINEL',                              // 14 request body
      'SELECT HashPass', 'database/traintrack.db',  // 15 SQL / DB path
    ];
    for (const leak of forbidden) {
      if (leak) assert.ok(!s.includes(leak), `security log leaked: ${leak}`);
    }
  } finally { app.appLogger.__setLevel('silent'); app.appLogger.__resetSink(); await app.close(); }
});

// 16. No runtime route (or server.js) imports the S6 helper modules yet.
test('S8-sweep-16. no route imports security/upload or security/validate', () => {
  const files = [SERVER_PATH];
  const routesDir = path.join(ROOT, 'routes');
  for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) files.push(path.join(routesDir, f));
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!src.includes('security/validate'), `${path.basename(f)} must not import security/validate`);
    assert.ok(!src.includes('security/upload'), `${path.basename(f)} must not import security/upload`);
  }
});

// 17. The app uses an isolated temp DB/session — production paths are never opened.
test('S8-sweep-17. tests run against an isolated temp DB/session', async () => {
  const app = await startTestApp();
  try {
    assert.ok(app.dbPath.includes('.tmp'), 'temp DB path under tests/.tmp');
    assert.ok(!app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`), 'not the production DB');
    assert.ok(app.sessDir.includes('.tmp'), 'temp session dir under tests/.tmp');
  } finally { await app.close(); }
});
