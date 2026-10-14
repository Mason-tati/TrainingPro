// WP-25 · Phase 7 — Enterprise Document Engine Runtime Production Validator tests.
// Validates the complete production runtime lifecycle — Application Startup -> ... -> Mounted Engine
// -> Authentication -> RBAC -> Middleware -> Route Resolution -> Mounted Endpoint -> Controller ->
// Service -> Repository -> Database -> Response -> Production Runtime Complete — proving every stage
// executes exactly once, in order, with no duplicate startup/mount/registration/request, and that
// production completion fires exactly once at the end. Disabled is a strict no-op; validating the
// lifecycle does NOT make the engine live (production/mode stay false/FOUNDATION). Reuses the Phase 6
// startup validator; production modules are untouched.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const P = require(path.join(EDIR, 'runtime-production-validator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeStartupValidator = require(path.join(EDIR, 'runtime-startup-validator.js'));

const STARTUP_SEQUENCE = ['application-startup', 'runtime-initialization', 'feature-flag-evaluation', 'express-startup', 'mounted-engine'];
const PRODUCTION_ORDER = STARTUP_SEQUENCE.concat(['production-runtime-complete']);

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
const mountOf = () => runtimeStartupValidator.getRuntimeRouteValidator().getRuntimeMiddlewareValidator().getRuntimeAuthenticationValidator().getRuntimeRequestValidator().getRuntimeValidator().getServerMount();

// ---------------------------------------------------------------------------

test('W25P7-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(P).sort(), [
    'capabilities', 'createRuntimeProductionValidator', 'getRuntimeStartupValidator', 'getStatus',
    'health', 'isProductionValidationEnabled', 'validateProduction',
  ]);
  for (const k of Object.keys(P)) assert.equal(typeof P[k], 'function', `${k} is a function`);
});

test('W25P7-2. default OFF — disabled validates nothing (no lifecycle, no execution)', async () => {
  await withUnset(async () => {
    assert.equal(P.isProductionValidationEnabled(), false);
    assert.equal(P.createRuntimeProductionValidator().enabled, false);
    assert.equal(P.getStatus().enabled, false);
    assert.equal(P.health().enabled, false);
    const r = await P.validateProduction();
    assert.equal(r.validated, false);
    assert.deepEqual(r.productionOrder, []);
    assert.equal(r.counts.applicationStartup, 0);
    assert.equal(r.counts.productionComplete, 0);
    assert.equal(r.counts.response, 0);
  });
});

test('W25P7-3. runtime flag delegation + reuses the Phase 6 startup validator', async () => {
  await withUnset(() => assert.equal(P.isProductionValidationEnabled(), runtimeFeatureFlag.isEnabled()));
  await withEnabled(() => assert.equal(P.isProductionValidationEnabled(), true));
  await withEnv('false', () => assert.equal(P.isProductionValidationEnabled(), false));
  assert.equal(P.getRuntimeStartupValidator(), runtimeStartupValidator);
  assert.equal(P.createRuntimeProductionValidator().startupValidator, runtimeStartupValidator);
});

test('W25P7-4. production validation — enabled lifecycle validates and stays gated (not live)', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.equal(r.enabled, true);
    assert.equal(r.validated, true);
    assert.equal(r.productionValidated, true);
    assert.equal(r.status.production, false, 'validating the lifecycle does not make the engine live');
    assert.equal(r.status.mode, 'FOUNDATION');
  });
});

test('W25P7-5. startup validator reuse — startup stages each execute once', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.equal(r.startupValidated, true);
    assert.equal(r.counts.applicationStartup, 1);
    assert.equal(r.counts.runtimeInitialization, 1);
    assert.equal(r.counts.featureFlagEvaluation, 1);
    assert.equal(r.counts.expressStartup, 1);
    assert.equal(r.counts.mountedEngine, 1);
  });
});

test('W25P7-6. exactly-once execution — full chain each stage once', async () => {
  await withEnabled(async () => {
    const c = (await P.validateProduction()).counts;
    for (const k of ['route', 'endpoint', 'authentication', 'rbac', 'middleware', 'controller', 'service', 'repository', 'sql', 'response']) {
      assert.equal(c[k], 1, `${k} executed exactly once`);
    }
  });
});

test('W25P7-7. production runtime completion — fires exactly once', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.equal(r.productionCompletionValidated, true);
    assert.equal(r.counts.productionComplete, 1);
  });
});

test('W25P7-8. duplicate startup prevention — application startup runs exactly once', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.equal(r.duplicateStartupSafe, true);
    assert.equal(r.counts.applicationStartup, 1);
  });
});

test('W25P7-9. duplicate mount prevention — mounted engine runs exactly once', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.equal(r.duplicateMountSafe, true);
    assert.equal(r.counts.mountedEngine, 1);
  });
});

test('W25P7-10. duplicate registration prevention — mount path resolves to one registration', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.equal(r.duplicateRegistrationSafe, true);
    assert.equal(r.counts.route, 1);
  });
});

test('W25P7-11. duplicate request prevention — repeated validations are independent (no accumulation)', async () => {
  await withEnabled(async () => {
    const a = await P.validateProduction();
    const b = await P.validateProduction();
    assert.equal(a.duplicateRequestSafe, true);
    assert.equal(a.counts.productionComplete, 1);
    assert.deepEqual(b.counts, a.counts, 'each run resolves the same exactly-once counts — stateless');
  });
});

test('W25P7-12. startup ordering — the startup lifecycle executes in the required sequence', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.deepEqual(r.startupOrder, STARTUP_SEQUENCE);
    assert.equal(r.startupOrderingValidated, true);
  });
});

test('W25P7-13. middleware ordering — authentication precedes RBAC precedes middleware', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.deepEqual(r.order, ['authentication', 'rbac', 'middleware']);
    assert.equal(r.orderingValidated, true);
  });
});

test('W25P7-14. production ordering — production completion is the final lifecycle stage', async () => {
  await withEnabled(async () => {
    const r = await P.validateProduction();
    assert.deepEqual(r.productionOrder, PRODUCTION_ORDER);
    assert.equal(r.productionOrderingValidated, true);
    assert.equal(r.productionOrder[r.productionOrder.length - 1], 'production-runtime-complete');
  });
});

test('W25P7-15. route/startup ordering (real Express) — engine appended after existing routes; single layer; disabled untouched', async () => {
  await withEnabled(() => {
    const app = express();
    app.get('/existing', (req, res) => res.end());
    const before = app._router.stack.length;
    mountOf().mount(app);
    const stack = app._router.stack;
    const existingIdx = stack.findIndex((l) => l.route && l.route.path === '/existing');
    const engineIdx = stack.findIndex((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(existingIdx >= 0 && engineIdx > existingIdx, 'engine layer comes after the pre-existing route');
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

test('W25P7-16. deterministic behaviour — identical runs are byte-for-byte equal', async () => {
  await withEnabled(async () => {
    const a = await P.validateProduction();
    const b = await P.validateProduction();
    assert.deepEqual(a, b);
  });
});

test('W25P7-17. copy-on-read — status/health/capabilities/descriptor are fresh objects every call', () => {
  const s1 = P.getStatus(); const s2 = P.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(P.getStatus().mode, 'FOUNDATION');
  const h1 = P.health(); const h2 = P.health();
  assert.notEqual(h1, h2); h1.ready = false; assert.equal(P.health().ready, true);
  const c1 = P.capabilities(); const c2 = P.capabilities();
  assert.notEqual(c1, c2); assert.notEqual(c1[0], c2[0]); c1[0].available = false; assert.equal(P.capabilities()[0].available, true);
  const d1 = P.createRuntimeProductionValidator(); const d2 = P.createRuntimeProductionValidator();
  assert.notEqual(d1, d2); assert.notEqual(d1.status, d2.status);
});

test('W25P7-18. import whitelist — only runtime-feature-flag and runtime-startup-validator', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-production-validator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './runtime-startup-validator']);
});

test('W25P7-19. forbidden API scan — no Express/http/db/env/server creation in the module', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-production-validator.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use in the module');
});

test('W25P7-20. no regression — the validator is UNWIRED (server.js does not reference it)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-production-validator'), 'server.js must not import this validator');
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
});
