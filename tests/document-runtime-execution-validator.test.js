// WP-25 · Phase 1 — Enterprise Document Engine Runtime Execution Validator tests.
// Validates the complete runtime execution chain (Express -> Mount -> Controller -> Service ->
// Repository -> Database) exercised via the WP-24 server mount, while preserving the feature-flag
// safety model: disabled is a strict no-op (nothing executed, no SQL, no behaviour change); enabled
// exercises each stage exactly once (no duplicate registration, no duplicate execution) against an
// instrumented in-memory connection — never the production database.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const V = require(path.join(EDIR, 'runtime-execution-validator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));

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

// A working instrumented sqlite3-style connection whose get() is counted, for injected-db tests.
function workingSpyDb(spy) {
  return {
    run(sql, params, cb) { spy.run += 1; cb.call({ lastID: 1, changes: 1 }, null); },
    get(sql, params, cb) { spy.get += 1; cb(null, { DocumentID: 1, IsDeleted: 0 }); },
    all(sql, params, cb) { spy.all += 1; cb(null, []); },
  };
}
const engineLayers = (app) => (app._router && app._router.stack || []).filter((l) => l.regexp && l.regexp.toString().includes('document-engine')).length;

// ---------------------------------------------------------------------------

test('W25P1-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(V).sort(), [
    'capabilities', 'createRuntimeExecutionValidator', 'getServerMount', 'getStatus',
    'health', 'isRuntimeValidationEnabled', 'validateRuntimeExecution',
  ]);
  for (const k of Object.keys(V)) assert.equal(typeof V[k], 'function', `${k} is a function`);
});

test('W25P1-2. runtime flag delegation — isRuntimeValidationEnabled mirrors runtime-feature-flag', async () => {
  await withUnset(() => { assert.equal(V.isRuntimeValidationEnabled(), runtimeFeatureFlag.isEnabled()); assert.equal(V.isRuntimeValidationEnabled(), false); });
  await withEnabled(() => { assert.equal(V.isRuntimeValidationEnabled(), runtimeFeatureFlag.isEnabled()); assert.equal(V.isRuntimeValidationEnabled(), true); });
  await withEnv('false', () => assert.equal(V.isRuntimeValidationEnabled(), false));
});

test('W25P1-3. default OFF — validator descriptor and status report disabled by default', async () => {
  await withUnset(() => {
    assert.equal(V.isRuntimeValidationEnabled(), false);
    assert.equal(V.createRuntimeExecutionValidator().enabled, false);
    assert.equal(V.getStatus().enabled, false);
    assert.equal(V.health().enabled, false);
    assert.equal(V.getServerMount(), require(path.join(EDIR, 'server-mount-integration.js')));
  });
});

test('W25P1-4. disabled path executes NOTHING (no controller/service/repository/SQL, injected db untouched)', async () => {
  await withUnset(async () => {
    const spy = { run: 0, get: 0, all: 0 };
    const r = await V.validateRuntimeExecution({ db: workingSpyDb(spy) });
    assert.equal(r.enabled, false);
    assert.equal(r.executed, false);
    for (const k of ['express', 'mount', 'controller', 'service', 'repository', 'database', 'duplicateRegistrationSafe']) assert.equal(r[k], false, `${k} false`);
    assert.deepEqual(r.counts, { controller: 0, service: 0, repository: 0, sql: 0 });
    assert.equal(spy.get, 0, 'injected db was never touched when disabled');
  });
});

test('W25P1-5. enabled runtime path — every stage validates and executed is true', async () => {
  await withEnabled(async () => {
    const r = await V.validateRuntimeExecution();
    assert.equal(r.enabled, true);
    assert.equal(r.executed, true);
    for (const k of ['express', 'mount', 'controller', 'service', 'repository', 'database', 'duplicateRegistrationSafe']) assert.equal(r[k], true, `${k} validated`);
    assert.equal(r.status.production, false, 'never claims production');
  });
});

test('W25P1-6. controller invoked exactly once', async () => {
  await withEnabled(async () => { assert.equal((await V.validateRuntimeExecution()).counts.controller, 1); });
});

test('W25P1-7. service invoked exactly once', async () => {
  await withEnabled(async () => { assert.equal((await V.validateRuntimeExecution()).counts.service, 1); });
});

test('W25P1-8. repository invoked exactly once', async () => {
  await withEnabled(async () => { assert.equal((await V.validateRuntimeExecution()).counts.repository, 1); });
});

test('W25P1-9. SQL executed exactly once (internal, and once on an injected connection)', async () => {
  await withEnabled(async () => {
    assert.equal((await V.validateRuntimeExecution()).counts.sql, 1, 'internal instrumented connection: one SQL');
    const spy = { run: 0, get: 0, all: 0 };
    const r = await V.validateRuntimeExecution({ db: workingSpyDb(spy) }); // covers injected-db path
    assert.equal(r.counts.sql, 1);
    assert.equal(spy.get, 1, 'injected connection saw exactly one read');
    assert.equal(spy.run + spy.all, 0, 'no write/list SQL on the validated read path');
  });
});

test('W25P1-10. duplicate request safety — repeated validations are independent (no accumulation)', async () => {
  await withEnabled(async () => {
    const a = await V.validateRuntimeExecution();
    const b = await V.validateRuntimeExecution();
    assert.deepEqual(a.counts, { controller: 1, service: 1, repository: 1, sql: 1 });
    assert.deepEqual(b.counts, a.counts, 'each run resolves the same exactly-once counts — stateless');
  });
});

test('W25P1-11. duplicate registration safety — no second mount (result flag + real Express single layer)', async () => {
  await withEnabled(async () => {
    assert.equal((await V.validateRuntimeExecution()).duplicateRegistrationSafe, true);
    const app = express();
    const mount = V.getServerMount();
    mount.mount(app);
    mount.mount(app);
    mount.mount(app);
    assert.equal(engineLayers(app), 1, 'exactly one document-engine layer after repeated mounts');
  });
});

test('W25P1-12. middleware ordering — the engine layer registers at the document-engine path', async () => {
  await withEnabled(() => {
    const app = express();
    V.getServerMount().mount(app);
    const layer = app._router.stack.find((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(layer, 'a document-engine middleware layer exists');
    assert.ok(layer.regexp.test('/api/document-engine'), 'it matches the mount path');
  });
});

test('W25P1-13. route ordering — the engine mount is appended AFTER existing routes (no reordering)', async () => {
  await withEnabled(() => {
    const app = express();
    app.get('/existing', (req, res) => res.end());
    V.getServerMount().mount(app);
    const stack = app._router.stack;
    const existingIdx = stack.findIndex((l) => l.route && l.route.path === '/existing');
    const engineIdx = stack.findIndex((l) => l.regexp && l.regexp.toString().includes('document-engine'));
    assert.ok(existingIdx >= 0 && engineIdx > existingIdx, 'engine layer comes after the pre-existing route');
  });
});

test('W25P1-14. startup ordering — enabled appends one layer; disabled leaves the app untouched', async () => {
  await withEnabled(() => {
    const app = express();
    app.get('/x', (req, res) => res.end());
    const before = app._router.stack.length;
    const r = V.getServerMount().mount(app);
    assert.equal(r.mounted, true);
    assert.equal(engineLayers(app), 1);
    assert.ok(app._router.stack.length > before, 'a layer was appended at startup');
  });
  await withUnset(() => {
    const app = express();
    app.get('/x', (req, res) => res.end());
    const before = app._router.stack.length;
    const r = V.getServerMount().mount(app);
    assert.deepEqual(r, { mounted: false });
    assert.equal(engineLayers(app), 0);
    assert.equal(app._router.stack.length, before, 'disabled startup changes nothing');
  });
});

test('W25P1-15. no regression — the validator is UNWIRED (server.js does not reference it)', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!server.includes('runtime-execution-validator'), 'server.js must not import the validator');
  // only the single authorized server-mount-integration reference remains
  const stripped = server.replace(/[^\n]*server-mount-integration[^\n]*/g, '');
  assert.ok(!stripped.includes('document-engine'), 'no other document-engine reference in server.js');
});

test('W25P1-16. import whitelist — only runtime-feature-flag and server-mount-integration', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-execution-validator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-mount-integration']);
});

test('W25P1-17. forbidden API scan — no Express/http/db/env/server creation in the module', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-execution-validator.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only the runtime flag reads env)');
  assert.ok(!/createServer\(|\.listen\(|express\.Router\(|express\(\)|app\.use\(/.test(src), 'no server/router/listen/app.use in the module');
});

test('W25P1-18. runtime status — enabled run reports the full validated status contract', async () => {
  await withEnabled(async () => {
    const s = (await V.validateRuntimeExecution()).status;
    for (const k of ['enabled', 'runtimeValidated', 'mountValidated', 'controllerValidated', 'serviceValidated', 'repositoryValidated', 'databaseValidated', 'registered', 'mounted', 'production', 'mode']) {
      assert.ok(Object.prototype.hasOwnProperty.call(s, k), `status includes ${k}`);
    }
    assert.equal(s.enabled, true);
    assert.equal(s.runtimeValidated, true);
    assert.equal(s.production, false);
    assert.equal(s.mode, 'FOUNDATION');
  });
});

test('W25P1-19. deterministic + never-throws — stable results; hostile inputs degrade safely', async () => {
  await withEnabled(async () => {
    const a = await V.validateRuntimeExecution();
    const b = await V.validateRuntimeExecution();
    assert.deepEqual(a, b, 'identical runs are byte-for-byte deterministic');
    // non-object options normalise to {} (covers isPlainObject branches) and still validate
    assert.equal((await V.validateRuntimeExecution(null)).executed, true);
    assert.equal((await V.validateRuntimeExecution([])).executed, true);
    // a hostile connection never throws — it degrades to an explicit negative result (covers catch)
    const bad = await V.validateRuntimeExecution({ db: { run() {}, get() { throw new Error('boom'); }, all() {} } });
    assert.equal(bad.enabled, true);
    assert.equal(bad.executed, false);
    assert.equal(bad.status.runtimeValidated, false);
  });
});

test('W25P1-20. copy-on-read — status/health/capabilities/descriptor are fresh objects every call', () => {
  const s1 = V.getStatus(); const s2 = V.getStatus();
  assert.notEqual(s1, s2); s1.mode = 'HACKED'; assert.equal(V.getStatus().mode, 'FOUNDATION');
  const h1 = V.health(); const h2 = V.health();
  assert.notEqual(h1, h2); h1.ready = false; assert.equal(V.health().ready, true);
  const c1 = V.capabilities(); const c2 = V.capabilities();
  assert.notEqual(c1, c2); assert.notEqual(c1[0], c2[0]); c1[0].available = false; assert.equal(V.capabilities()[0].available, true);
  const d1 = V.createRuntimeExecutionValidator(); const d2 = V.createRuntimeExecutionValidator();
  assert.notEqual(d1, d2); assert.notEqual(d1.status, d2.status);
});
