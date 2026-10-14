// WP-25 · Phase 2 — Enterprise Document Engine Runtime Request Validator tests.
// Validates LIVE request handling through the mounted engine: an HTTP request reaching the mounted
// route and producing exactly one response, composed with the exactly-once execution chain
// (Controller -> Service -> Repository -> Database) delegated to the Phase 1 validator. Disabled is a
// strict no-op (no request simulated, nothing executed, no response); enabled exercises each stage
// exactly once with no duplicate registration and no duplicate execution.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'runtime-request-validator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeExecutionValidator = require(path.join(EDIR, 'runtime-execution-validator.js'));

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
const mountOf = () => runtimeExecutionValidator.getServerMount();

// ---------------------------------------------------------------------------

test('W25P2-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(R).sort(), [
    'capabilities', 'createRuntimeRequestValidator', 'getRuntimeValidator', 'getStatus',
    'health', 'isRequestValidationEnabled', 'validateRequest',
  ]);
  for (const k of Object.keys(R)) assert.equal(typeof R[k], 'function', `${k} is a function`);
});

test('W25P2-2. default OFF — descriptor/status report disabled by default', async () => {
  await withUnset(() => {
    assert.equal(R.isRequestValidationEnabled(), false);
    assert.equal(R.createRuntimeRequestValidator().enabled, false);
    assert.equal(R.getStatus().enabled, false);
    assert.equal(R.health().enabled, false);
  });
});

test('W25P2-3. runtime flag delegation + reuses the Phase 1 validator', async () => {
  await withUnset(() => { assert.equal(R.isRequestValidationEnabled(), runtimeFeatureFlag.isEnabled()); });
  await withEnabled(() => { assert.equal(R.isRequestValidationEnabled(), true); });
  await withEnv('false', () => assert.equal(R.isRequestValidationEnabled(), false));
  assert.equal(R.getRuntimeValidator(), runtimeExecutionValidator);
  assert.equal(R.createRuntimeRequestValidator().runtimeValidator, runtimeExecutionValidator);
});

test('W25P2-4. disabled path validates NOTHING (no request, no execution, no response)', async () => {
  await withUnset(async () => {
    const r = await R.validateRequest();
    assert.equal(r.enabled, false);
    assert.equal(r.requestValidated, false);
    assert.equal(r.requestReached, false);
    assert.equal(r.responseValidated, false);
    assert.deepEqual(r.counts, { controller: 0, service: 0, repository: 0, sql: 0, response: 0 });
    assert.deepEqual(r.response, { status: 0, mounted: false, serving: false });
  });
});

test('W25P2-5. request validation — enabled request reaches the mount and validates end-to-end', async () => {
  await withEnabled(async () => {
    const r = await R.validateRequest();
    assert.equal(r.enabled, true);
    assert.equal(r.requestValidated, true);
    assert.equal(r.requestReached, true);
    assert.equal(r.status.production, false);
  });
});

test('W25P2-6. controller executes exactly once', async () => {
  await withEnabled(async () => { assert.equal((await R.validateRequest()).counts.controller, 1); });
});

test('W25P2-7. service executes exactly once', async () => {
  await withEnabled(async () => { assert.equal((await R.validateRequest()).counts.service, 1); });
});

test('W25P2-8. repository executes exactly once', async () => {
  await withEnabled(async () => { assert.equal((await R.validateRequest()).counts.repository, 1); });
});

test('W25P2-9. database executes exactly once', async () => {
  await withEnabled(async () => { assert.equal((await R.validateRequest()).counts.sql, 1); });
});

test('W25P2-10. response generated exactly once (single guarded 503 response)', async () => {
  await withEnabled(async () => {
    const r = await R.validateRequest();
    assert.equal(r.counts.response, 1, 'exactly one response emitted');
    assert.equal(r.responseValidated, true);
    assert.equal(r.response.status, 503);
    assert.equal(r.response.mounted, true);
    assert.equal(r.response.serving, false, 'guarded, non-serving in this phase');
  });
});

test('W25P2-11. duplicate request protection — repeated validations are independent (no accumulation)', async () => {
  await withEnabled(async () => {
    const a = await R.validateRequest();
    const b = await R.validateRequest();
    assert.equal(a.duplicateRequestSafe, true);
    assert.deepEqual(a.counts, { controller: 1, service: 1, repository: 1, sql: 1, response: 1 });
    assert.deepEqual(b.counts, a.counts, 'each request resolves the same exactly-once counts — stateless');
  });
});

test('W25P2-12. duplicate registration safety — no second mount (flag + real Express single layer)', async () => {
  await withEnabled(async () => {
    assert.equal((await R.validateRequest()).duplicateRegistrationSafe, true);
    const app = express();
    const mount = mountOf();
    mount.mount(app);
    mount.mount(app);
    mount.mount(app);
    assert.equal(engineLayers(app), 1, 'exactly one document-engine layer after repeated mounts');
  });
});

test('W25P2-13. middleware ordering — the engine layer registers at the document-engine path', async () => {
  await withEnabled(() => {
    const app = express();
    mountOf().mount(app);
    const layer = app._router.stack.find((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(layer, 'a document-engine middleware layer exists');
    assert.ok(layer.regexp.test('/api/document-engine'), 'it matches the mount path');
  });
});

test('W25P2-14. route ordering — the engine mount is appended AFTER existing routes', async () => {
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

test('W25P2-15. startup ordering — enabled appends one layer; disabled leaves the app untouched', async () => {
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

test('W25P2-16. deterministic behaviour — identical runs are byte-for-byte equal', async () => {
  await withEnabled(async () => {
    const a = await R.validateRequest();
    const b = await R.validateRequest();
    assert.deepEqual(a, b);
  });
});

test('W25P2-17. copy-on-read — status/health/capabilities/descriptor are fresh objects every call', () => {
  const s1 = R.getStatus(); const s2 = R.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(R.getStatus().mode, 'FOUNDATION');
  const h1 = R.health(); const h2 = R.health();
  assert.notEqual(h1, h2); h1.ready = false; assert.equal(R.health().ready, true);
  const c1 = R.capabilities(); const c2 = R.capabilities();
  assert.notEqual(c1, c2); assert.notEqual(c1[0], c2[0]); c1[0].available = false; assert.equal(R.capabilities()[0].available, true);
  const d1 = R.createRuntimeRequestValidator(); const d2 = R.createRuntimeRequestValidator();
  assert.notEqual(d1, d2); assert.notEqual(d1.status, d2.status);
});

test('W25P2-18. import whitelist — only runtime-feature-flag and runtime-execution-validator', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-request-validator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-execution-validator', './runtime-feature-flag']);
});

test('W25P2-19. forbidden API scan — no Express/http/db/env/server creation in the module', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-request-validator.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use in the module');
});

test('W25P2-20. no regression — the validator is UNWIRED (server.js does not reference it)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-request-validator'), 'server.js must not import the request validator');
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
});
