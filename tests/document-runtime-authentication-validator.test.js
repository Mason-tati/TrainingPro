// WP-25 · Phase 3 — Enterprise Document Engine Runtime Authentication & RBAC Validator tests.
// Validates the complete runtime security chain — Authentication -> RBAC -> Middleware -> Mounted
// Route -> Controller -> Service -> Repository -> Database -> Response — proving each stage executes
// exactly once, in order, with no duplicate middleware/authorization/request. Disabled is a strict
// no-op. The production auth/RBAC modules (lib/auth/*) are neither imported nor modified: the
// validator models the pipeline ordering and composes the Phase 2 request validation.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'runtime-authentication-validator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeRequestValidator = require(path.join(EDIR, 'runtime-request-validator.js'));

async function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try {
    if (value === undefined) delete process.env.DOCUMENT_ENGINE_ENABLED; else process.env.DOCUMENT_ENGINE_ENABLED = value;
    return await fn();
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
}
const withEnabled = (fn) => withEnv('true', fn);
const withUnset = (fn) => withEnv(undefined, fn);
const engineLayers = (app) => (app._router && app._router.stack || []).filter((l) => l.regexp && l.regexp.toString().includes('document-engine')).length;
const mountOf = () => runtimeRequestValidator.getRuntimeValidator().getServerMount();

// ---------------------------------------------------------------------------

test('W25P3-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'capabilities', 'createRuntimeAuthenticationValidator', 'getRuntimeRequestValidator', 'getStatus',
    'health', 'isAuthenticationValidationEnabled', 'validateAuthentication',
  ]);
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

test('W25P3-2. default OFF — disabled validates nothing (no pipeline, no execution)', async () => {
  await withUnset(async () => {
    assert.equal(A.isAuthenticationValidationEnabled(), false);
    assert.equal(A.createRuntimeAuthenticationValidator().enabled, false);
    assert.equal(A.getStatus().enabled, false);
    assert.equal(A.health().enabled, false);
    const r = await A.validateAuthentication();
    assert.equal(r.validated, false);
    assert.deepEqual(r.order, []);
    assert.deepEqual(r.counts, { authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0 });
  });
});

test('W25P3-3. runtime flag delegation + reuses the Phase 2 request validator', async () => {
  await withUnset(() => assert.equal(A.isAuthenticationValidationEnabled(), runtimeFeatureFlag.isEnabled()));
  await withEnabled(() => assert.equal(A.isAuthenticationValidationEnabled(), true));
  await withEnv('false', () => assert.equal(A.isAuthenticationValidationEnabled(), false));
  assert.equal(A.getRuntimeRequestValidator(), runtimeRequestValidator);
  assert.equal(A.createRuntimeAuthenticationValidator().requestValidator, runtimeRequestValidator);
});

test('W25P3-4. authentication validation — enabled chain validates and authentication runs once', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.equal(r.enabled, true);
    assert.equal(r.validated, true);
    assert.equal(r.authenticationValidated, true);
    assert.equal(r.counts.authentication, 1);
    assert.equal(r.status.production, false);
  });
});

test('W25P3-5. RBAC validation — authorization executes exactly once', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.equal(r.rbacValidated, true);
    assert.equal(r.counts.rbac, 1);
  });
});

test('W25P3-6. middleware validation — middleware executes exactly once', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.equal(r.middlewareValidated, true);
    assert.equal(r.counts.middleware, 1);
  });
});

test('W25P3-7. exactly-once execution — controller/service/repository/database each once', async () => {
  await withEnabled(async () => {
    const c = (await A.validateAuthentication()).counts;
    assert.equal(c.controller, 1);
    assert.equal(c.service, 1);
    assert.equal(c.repository, 1);
    assert.equal(c.sql, 1);
  });
});

test('W25P3-8. response validation — response generated exactly once', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.equal(r.responseValidated, true);
    assert.equal(r.counts.response, 1);
  });
});

test('W25P3-9. duplicate middleware protection — middleware not executed twice', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.equal(r.duplicateMiddlewareSafe, true);
    assert.equal(r.counts.middleware, 1);
  });
});

test('W25P3-10. duplicate authorization protection — RBAC not executed twice', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.equal(r.duplicateAuthorizationSafe, true);
    assert.equal(r.counts.rbac, 1);
  });
});

test('W25P3-11. duplicate request protection — repeated validations are independent (no accumulation)', async () => {
  await withEnabled(async () => {
    const a = await A.validateAuthentication();
    const b = await A.validateAuthentication();
    assert.equal(a.duplicateRequestSafe, true);
    assert.deepEqual(a.counts, { authentication: 1, rbac: 1, middleware: 1, controller: 1, service: 1, repository: 1, sql: 1, response: 1 });
    assert.deepEqual(b.counts, a.counts, 'each run resolves the same exactly-once counts — stateless');
  });
});

test('W25P3-12. security ordering — authentication precedes RBAC precedes middleware', async () => {
  await withEnabled(async () => {
    const r = await A.validateAuthentication();
    assert.deepEqual(r.order, ['authentication', 'rbac', 'middleware']);
    assert.equal(r.orderingValidated, true);
  });
});

test('W25P3-13. middleware ordering — the engine layer registers at the document-engine path', async () => {
  await withEnabled(() => {
    const app = express();
    mountOf().mount(app);
    const layer = app._router.stack.find((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(layer, 'a document-engine middleware layer exists');
    assert.ok(layer.regexp.test('/api/document-engine'), 'it matches the mount path');
  });
});

test('W25P3-14. route ordering — the engine mount is appended AFTER existing routes', async () => {
  await withEnabled(() => {
    const app = express();
    app.get('/existing', (req, res) => res.end());
    mountOf().mount(app);
    const stack = app._router.stack;
    const existingIdx = stack.findIndex((l) => l.route && l.route.path === '/existing');
    const engineIdx = stack.findIndex((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(existingIdx >= 0 && engineIdx > existingIdx, 'engine layer comes after the pre-existing route');
  });
});

test('W25P3-15. startup ordering — enabled appends one layer; disabled leaves the app untouched', async () => {
  await withEnabled(() => {
    const app = express();
    app.get('/x', (req, res) => res.end());
    const before = app._router.stack.length;
    const res = mountOf().mount(app);
    assert.equal(res.mounted, true);
    assert.equal(engineLayers(app), 1);
    assert.ok(app._router.stack.length > before);
  });
  await withUnset(() => {
    const app = express();
    app.get('/x', (req, res) => res.end());
    const before = app._router.stack.length;
    const res = mountOf().mount(app);
    assert.deepEqual(res, { mounted: false });
    assert.equal(engineLayers(app), 0);
    assert.equal(app._router.stack.length, before, 'disabled startup changes nothing');
  });
});

test('W25P3-16. deterministic behaviour — identical runs are byte-for-byte equal', async () => {
  await withEnabled(async () => {
    const a = await A.validateAuthentication();
    const b = await A.validateAuthentication();
    assert.deepEqual(a, b);
  });
});

test('W25P3-17. copy-on-read — status/health/capabilities/descriptor are fresh objects every call', () => {
  const s1 = A.getStatus(); const s2 = A.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(A.getStatus().mode, 'FOUNDATION');
  const h1 = A.health(); const h2 = A.health();
  assert.notEqual(h1, h2); h1.ready = false; assert.equal(A.health().ready, true);
  const c1 = A.capabilities(); const c2 = A.capabilities();
  assert.notEqual(c1, c2); assert.notEqual(c1[0], c2[0]); c1[0].available = false; assert.equal(A.capabilities()[0].available, true);
  const d1 = A.createRuntimeAuthenticationValidator(); const d2 = A.createRuntimeAuthenticationValidator();
  assert.notEqual(d1, d2); assert.notEqual(d1.status, d2.status);
});

test('W25P3-18. import whitelist — only runtime-feature-flag and runtime-request-validator', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-authentication-validator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './runtime-request-validator']);
  // the production auth/RBAC modules must NOT be imported
  assert.ok(!/require\(['"][^'"]*auth[^'"]*['"]\)/.test(src), 'no lib/auth import');
});

test('W25P3-19. forbidden API scan — no Express/http/db/env/server creation in the module', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-authentication-validator.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use in the module');
});

test('W25P3-20. no regression — validator UNWIRED and auth/RBAC modules untouched by it', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-authentication-validator'), 'server.js must not import this validator');
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
  // the production auth/RBAC implementation is never IMPORTED by this engine module (a comment may
  // reference lib/auth to document that it is intentionally not imported).
  const src = fs.readFileSync(path.join(EDIR, 'runtime-authentication-validator.js'), 'utf8');
  assert.ok(!/require\([^)]*auth[^)]*\)/.test(src), 'the validator does not import any auth module');
});
