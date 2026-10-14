// WP-25 · Phase 4 — Enterprise Document Engine Runtime Middleware Validator tests.
// Validates the complete runtime middleware pipeline — Authentication -> RBAC -> Middleware ->
// Mounted Route -> Controller -> Service -> Repository -> Database -> Response — from the middleware
// perspective: every middleware and every downstream stage executes exactly once, in order, with no
// duplicate middleware execution and no duplicate request. Disabled is a strict no-op. Reuses the
// Phase 3 authentication validator; production middleware/auth/RBAC modules are untouched.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'runtime-middleware-validator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeAuthenticationValidator = require(path.join(EDIR, 'runtime-authentication-validator.js'));

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
const mountOf = () => runtimeAuthenticationValidator.getRuntimeRequestValidator().getRuntimeValidator().getServerMount();

// ---------------------------------------------------------------------------

test('W25P4-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'createRuntimeMiddlewareValidator', 'getRuntimeAuthenticationValidator', 'getStatus',
    'health', 'isMiddlewareValidationEnabled', 'validateMiddleware',
  ]);
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

test('W25P4-2. default OFF — disabled validates nothing (no pipeline, no execution)', async () => {
  await withUnset(async () => {
    assert.equal(M.isMiddlewareValidationEnabled(), false);
    assert.equal(M.createRuntimeMiddlewareValidator().enabled, false);
    assert.equal(M.getStatus().enabled, false);
    assert.equal(M.health().enabled, false);
    const r = await M.validateMiddleware();
    assert.equal(r.validated, false);
    assert.deepEqual(r.order, []);
    assert.deepEqual(r.counts, { authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0 });
  });
});

test('W25P4-3. runtime flag delegation + reuses the Phase 3 authentication validator', async () => {
  await withUnset(() => assert.equal(M.isMiddlewareValidationEnabled(), runtimeFeatureFlag.isEnabled()));
  await withEnabled(() => assert.equal(M.isMiddlewareValidationEnabled(), true));
  await withEnv('false', () => assert.equal(M.isMiddlewareValidationEnabled(), false));
  assert.equal(M.getRuntimeAuthenticationValidator(), runtimeAuthenticationValidator);
  assert.equal(M.createRuntimeMiddlewareValidator().authenticationValidator, runtimeAuthenticationValidator);
});

test('W25P4-4. middleware validation — enabled pipeline validates and middleware runs once', async () => {
  await withEnabled(async () => {
    const r = await M.validateMiddleware();
    assert.equal(r.enabled, true);
    assert.equal(r.validated, true);
    assert.equal(r.middlewareValidated, true);
    assert.equal(r.counts.middleware, 1);
    assert.equal(r.status.production, false);
  });
});

test('W25P4-5. authentication + RBAC validation reuse — each executes exactly once', async () => {
  await withEnabled(async () => {
    const r = await M.validateMiddleware();
    assert.equal(r.authenticationValidated, true);
    assert.equal(r.rbacValidated, true);
    assert.equal(r.counts.authentication, 1);
    assert.equal(r.counts.rbac, 1);
  });
});

test('W25P4-6. mounted route reached exactly once (request + response validated)', async () => {
  await withEnabled(async () => {
    const r = await M.validateMiddleware();
    assert.equal(r.requestValidated, true);
    assert.equal(r.responseValidated, true);
    assert.equal(r.counts.response, 1);
  });
});

test('W25P4-7. exactly-once execution — controller/service/repository/database each once', async () => {
  await withEnabled(async () => {
    const c = (await M.validateMiddleware()).counts;
    assert.equal(c.controller, 1);
    assert.equal(c.service, 1);
    assert.equal(c.repository, 1);
    assert.equal(c.sql, 1);
  });
});

test('W25P4-8. response validation — response generated exactly once', async () => {
  await withEnabled(async () => {
    const r = await M.validateMiddleware();
    assert.equal(r.responseValidated, true);
    assert.equal(r.counts.response, 1);
  });
});

test('W25P4-9. duplicate middleware prevention — middleware not executed twice', async () => {
  await withEnabled(async () => {
    const r = await M.validateMiddleware();
    assert.equal(r.duplicateMiddlewareSafe, true);
    assert.equal(r.counts.middleware, 1);
  });
});

test('W25P4-10. duplicate request prevention — repeated validations are independent (no accumulation)', async () => {
  await withEnabled(async () => {
    const a = await M.validateMiddleware();
    const b = await M.validateMiddleware();
    assert.equal(a.duplicateRequestSafe, true);
    assert.deepEqual(a.counts, { authentication: 1, rbac: 1, middleware: 1, controller: 1, service: 1, repository: 1, sql: 1, response: 1 });
    assert.deepEqual(b.counts, a.counts, 'each run resolves the same exactly-once counts — stateless');
  });
});

test('W25P4-11. middleware ordering — authentication precedes RBAC precedes middleware', async () => {
  await withEnabled(async () => {
    const r = await M.validateMiddleware();
    assert.deepEqual(r.order, ['authentication', 'rbac', 'middleware']);
    assert.equal(r.orderingValidated, true);
  });
});

test('W25P4-12. duplicate registration prevention — real Express single engine layer', async () => {
  await withEnabled(() => {
    const app = express();
    const mount = mountOf();
    mount.mount(app);
    mount.mount(app);
    mount.mount(app);
    assert.equal(engineLayers(app), 1, 'exactly one document-engine layer after repeated mounts');
  });
});

test('W25P4-13. middleware ordering (Express) — the engine layer registers at the document-engine path', async () => {
  await withEnabled(() => {
    const app = express();
    mountOf().mount(app);
    const layer = app._router.stack.find((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(layer, 'a document-engine middleware layer exists');
    assert.ok(layer.regexp.test('/api/document-engine'), 'it matches the mount path');
  });
});

test('W25P4-14. route ordering — the engine mount is appended AFTER existing routes', async () => {
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

test('W25P4-15. startup ordering — enabled appends one layer; disabled leaves the app untouched', async () => {
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

test('W25P4-16. deterministic behaviour — identical runs are byte-for-byte equal', async () => {
  await withEnabled(async () => {
    const a = await M.validateMiddleware();
    const b = await M.validateMiddleware();
    assert.deepEqual(a, b);
  });
});

test('W25P4-17. copy-on-read — status/health/capabilities/descriptor are fresh objects every call', () => {
  const s1 = M.getStatus(); const s2 = M.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(M.getStatus().mode, 'FOUNDATION');
  const h1 = M.health(); const h2 = M.health();
  assert.notEqual(h1, h2); h1.ready = false; assert.equal(M.health().ready, true);
  const c1 = M.capabilities(); const c2 = M.capabilities();
  assert.notEqual(c1, c2); assert.notEqual(c1[0], c2[0]); c1[0].available = false; assert.equal(M.capabilities()[0].available, true);
  const d1 = M.createRuntimeMiddlewareValidator(); const d2 = M.createRuntimeMiddlewareValidator();
  assert.notEqual(d1, d2); assert.notEqual(d1.status, d2.status);
});

test('W25P4-18. import whitelist — only runtime-feature-flag and runtime-authentication-validator', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-middleware-validator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-authentication-validator', './runtime-feature-flag']);
});

test('W25P4-19. forbidden API scan — no Express/http/db/env/server creation in the module', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-middleware-validator.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use in the module');
});

test('W25P4-20. no regression — the validator is UNWIRED (server.js does not reference it)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-middleware-validator'), 'server.js must not import this validator');
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
});
