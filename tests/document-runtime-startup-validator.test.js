// WP-25 · Phase 6 — Enterprise Document Engine Runtime Startup Validator tests.
// Validates the complete startup lifecycle — Application Startup -> Runtime Initialization -> Feature
// Flag Evaluation -> Express Startup -> Mounted Engine -> Authentication -> RBAC -> Middleware ->
// Route Resolution -> Mounted Endpoint -> Controller -> Service -> Repository -> Database -> Response
// — proving every startup and downstream stage executes exactly once, in order, with no duplicate
// startup/mount/registration/request. Disabled is a strict no-op. Reuses the Phase 5 route validator;
// production modules are untouched.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const S = require(path.join(EDIR, 'runtime-startup-validator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeRouteValidator = require(path.join(EDIR, 'runtime-route-validator.js'));

const STARTUP_SEQUENCE = ['application-startup', 'runtime-initialization', 'feature-flag-evaluation', 'express-startup', 'mounted-engine'];

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
const mountOf = () => runtimeRouteValidator.getRuntimeMiddlewareValidator().getRuntimeAuthenticationValidator().getRuntimeRequestValidator().getRuntimeValidator().getServerMount();

// ---------------------------------------------------------------------------

test('W25P6-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'capabilities', 'createRuntimeStartupValidator', 'getRuntimeRouteValidator', 'getStatus',
    'health', 'isStartupValidationEnabled', 'validateStartup',
  ]);
  for (const k of Object.keys(S)) assert.equal(typeof S[k], 'function', `${k} is a function`);
});

test('W25P6-2. default OFF — disabled validates nothing (no startup, no execution)', async () => {
  await withUnset(async () => {
    assert.equal(S.isStartupValidationEnabled(), false);
    assert.equal(S.createRuntimeStartupValidator().enabled, false);
    assert.equal(S.getStatus().enabled, false);
    assert.equal(S.health().enabled, false);
    const r = await S.validateStartup();
    assert.equal(r.validated, false);
    assert.deepEqual(r.startupOrder, []);
    assert.deepEqual(r.order, []);
    assert.equal(r.counts.applicationStartup, 0);
    assert.equal(r.counts.mountedEngine, 0);
    assert.equal(r.counts.response, 0);
  });
});

test('W25P6-3. runtime flag delegation + reuses the Phase 5 route validator', async () => {
  await withUnset(() => assert.equal(S.isStartupValidationEnabled(), runtimeFeatureFlag.isEnabled()));
  await withEnabled(() => assert.equal(S.isStartupValidationEnabled(), true));
  await withEnv('false', () => assert.equal(S.isStartupValidationEnabled(), false));
  assert.equal(S.getRuntimeRouteValidator(), runtimeRouteValidator);
  assert.equal(S.createRuntimeStartupValidator().routeValidator, runtimeRouteValidator);
});

test('W25P6-4. startup validation — enabled lifecycle validates end-to-end', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.equal(r.enabled, true);
    assert.equal(r.validated, true);
    assert.equal(r.startupValidated, true);
    assert.equal(r.status.production, false);
  });
});

test('W25P6-5. startup stages execute exactly once each', async () => {
  await withEnabled(async () => {
    const c = (await S.validateStartup()).counts;
    assert.equal(c.applicationStartup, 1);
    assert.equal(c.runtimeInitialization, 1);
    assert.equal(c.featureFlagEvaluation, 1);
    assert.equal(c.expressStartup, 1);
    assert.equal(c.mountedEngine, 1);
  });
});

test('W25P6-6. route validator reuse — route/middleware/auth/RBAC each execute once', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.equal(r.routeValidated, true);
    assert.equal(r.middlewareValidated, true);
    assert.equal(r.authenticationValidated, true);
    assert.equal(r.rbacValidated, true);
    assert.equal(r.counts.route, 1);
    assert.equal(r.counts.middleware, 1);
  });
});

test('W25P6-7. exactly-once execution — controller/service/repository/database/response each once', async () => {
  await withEnabled(async () => {
    const c = (await S.validateStartup()).counts;
    assert.equal(c.controller, 1);
    assert.equal(c.service, 1);
    assert.equal(c.repository, 1);
    assert.equal(c.sql, 1);
    assert.equal(c.response, 1);
  });
});

test('W25P6-8. duplicate startup prevention — application startup runs exactly once', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.equal(r.duplicateStartupSafe, true);
    assert.equal(r.counts.applicationStartup, 1);
  });
});

test('W25P6-9. duplicate mount prevention — mounted engine runs exactly once', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.equal(r.duplicateMountSafe, true);
    assert.equal(r.counts.mountedEngine, 1);
  });
});

test('W25P6-10. duplicate registration prevention — mount path resolves to one registration', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.equal(r.duplicateRegistrationSafe, true);
    assert.equal(r.counts.route, 1);
  });
});

test('W25P6-11. duplicate request prevention — repeated validations are independent (no accumulation)', async () => {
  await withEnabled(async () => {
    const a = await S.validateStartup();
    const b = await S.validateStartup();
    assert.equal(a.duplicateRequestSafe, true);
    assert.equal(a.counts.applicationStartup, 1);
    assert.equal(a.counts.response, 1);
    assert.deepEqual(b.counts, a.counts, 'each run resolves the same exactly-once counts — stateless');
  });
});

test('W25P6-12. startup ordering — the lifecycle executes in the required sequence', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.deepEqual(r.startupOrder, STARTUP_SEQUENCE);
    assert.equal(r.startupOrderingValidated, true);
  });
});

test('W25P6-13. middleware ordering — authentication precedes RBAC precedes middleware', async () => {
  await withEnabled(async () => {
    const r = await S.validateStartup();
    assert.deepEqual(r.order, ['authentication', 'rbac', 'middleware']);
    assert.equal(r.orderingValidated, true);
  });
});

test('W25P6-14. route ordering — the engine mount is appended AFTER existing routes (real Express)', async () => {
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

test('W25P6-15. startup ordering (real Express) — enabled appends one layer; disabled untouched', async () => {
  await withEnabled(() => {
    const app = express();
    app.get('/x', (req, res) => res.end());
    const before = app._router.stack.length;
    const res = mountOf().mount(app);
    assert.equal(res.mounted, true);
    assert.equal(engineLayers(app), 1);
    assert.ok(app._router.stack.length > before);
    mountOf().mount(app);
    assert.equal(engineLayers(app), 1, 'no duplicate mount on repeat');
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

test('W25P6-16. deterministic behaviour — identical runs are byte-for-byte equal', async () => {
  await withEnabled(async () => {
    const a = await S.validateStartup();
    const b = await S.validateStartup();
    assert.deepEqual(a, b);
  });
});

test('W25P6-17. copy-on-read — status/health/capabilities/descriptor are fresh objects every call', () => {
  const s1 = S.getStatus(); const s2 = S.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(S.getStatus().mode, 'FOUNDATION');
  const h1 = S.health(); const h2 = S.health();
  assert.notEqual(h1, h2); h1.ready = false; assert.equal(S.health().ready, true);
  const c1 = S.capabilities(); const c2 = S.capabilities();
  assert.notEqual(c1, c2); assert.notEqual(c1[0], c2[0]); c1[0].available = false; assert.equal(S.capabilities()[0].available, true);
  const d1 = S.createRuntimeStartupValidator(); const d2 = S.createRuntimeStartupValidator();
  assert.notEqual(d1, d2); assert.notEqual(d1.status, d2.status);
});

test('W25P6-18. import whitelist — only runtime-feature-flag and runtime-route-validator', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-startup-validator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './runtime-route-validator']);
});

test('W25P6-19. forbidden API scan — no Express/http/db/env/server creation in the module', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-startup-validator.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use in the module');
});

test('W25P6-20. no regression — the validator is UNWIRED (server.js does not reference it)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-startup-validator'), 'server.js must not import this validator');
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
});
