// WP-24 · Phase 3 — Enterprise Document Engine Controlled Persistence Handler Adapter tests.
// Verifies the adapter resolves the WP-24 Phase 2 binding and prepares a NON-executable handler
// descriptor reusing the existing controller + persistence services (same repository instances),
// while: enabled derives from ./runtime-feature-flag (OFF by default); NO writes/SQL and NO
// controller execution during construction; handler.executable is false; no route registration/
// Express/HTTP; only runtime-feature-flag reads env; copy-on-read; determinism; never throws; and
// the adapter remains unreachable (unwired).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'persistence-handler-adapter.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const persistenceControllerBinding = require(path.join(EDIR, 'persistence-controller-binding.js'));
const controller = require(path.join(EDIR, 'controller.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

// Fake sqlite3 connection with call counters (proves construction performs no writes/SQL).
function fakeDb() {
  const calls = { run: 0, get: 0, all: 0 };
  return {
    calls,
    run(...a) { calls.run += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb.call({ lastID: 0, changes: 0 }, null); },
    get(...a) { calls.get += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, null); },
    all(...a) { calls.all += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, []); },
  };
}

const STATUS = { handlerReady: true, bound: true, composed: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION' };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P3-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'capabilities', 'createPersistenceHandler', 'getNextPhase', 'getPersistenceBinding', 'getStatus', 'health', 'isHandlerEnabled',
  ]);
});

test('W24P3-2. every export is a function', () => {
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P3-3. isHandlerEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(A.isHandlerEnabled(), false);
    assert.equal(A.isHandlerEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P3-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    A.createPersistenceHandler();
    A.getPersistenceBinding();
    A.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(A.isHandlerEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getPersistenceBinding — delegates to the Phase 2 binding
// ---------------------------------------------------------------------------

test('W24P3-5. getPersistenceBinding delegates to persistence-controller-binding.createPersistenceControllerBinding()', () => {
  const binding = A.getPersistenceBinding();
  assert.deepEqual(Object.keys(binding).sort(), ['controller', 'enabled', 'services', 'status']);
  assert.deepEqual(Object.keys(binding).sort(), Object.keys(persistenceControllerBinding.createPersistenceControllerBinding()).sort());
});

test('W24P3-6. getPersistenceBinding returns a FRESH binding every call', () => {
  const a = A.getPersistenceBinding();
  const b = A.getPersistenceBinding();
  assert.notEqual(a, b);
  assert.notEqual(a.services, b.services);
});

test('W24P3-7. getPersistenceBinding(db) injects the handle through to the services (DB handle reuse)', () => {
  const db = fakeDb();
  const binding = A.getPersistenceBinding(db);
  assert.equal(binding.services.documentService.repository.db, db, 'service → repository → injected handle');
});

// ---------------------------------------------------------------------------
// createPersistenceHandler — the non-executable handler descriptor
// ---------------------------------------------------------------------------

test('W24P3-8. createPersistenceHandler returns the expected shape (binding + handler + status)', () => {
  withUnset(() => {
    const h = A.createPersistenceHandler();
    assert.deepEqual(Object.keys(h).sort(), ['binding', 'enabled', 'handler', 'status']);
    assert.equal(h.enabled, false);
    assert.deepEqual(h.status, STATUS);
    assert.deepEqual(Object.keys(h.handler).sort(), ['controller', 'executable', 'services', 'type']);
  });
});

test('W24P3-9. handler descriptor is NON-executable and persistence-backed (never an Express handler)', () => {
  const h = A.createPersistenceHandler();
  assert.equal(h.handler.type, 'persistence-backed');
  assert.equal(h.handler.executable, false);
  assert.equal(typeof h.handler, 'object'); // a descriptor, not a function
});

test('W24P3-10. handler reuses the EXISTING controller + the bound services (not duplicated)', () => {
  const h = A.createPersistenceHandler();
  assert.equal(h.binding.controller, controller, 'binding reuses existing controller');
  assert.equal(h.handler.controller, controller, 'handler reuses existing controller');
  assert.equal(h.handler.services, h.binding.services, 'handler reuses the bound services (same instances)');
  assert.equal(typeof h.handler.controller.create, 'function'); // controller surface intact
});

test('W24P3-11. repository instances reused end-to-end (service → repository → injected handle)', () => {
  const db = fakeDb();
  const h = A.createPersistenceHandler({ db });
  assert.equal(h.handler.services.documentService.repository.db, db);
  assert.equal(h.binding.services.documentService.repository, h.handler.services.documentService.repository, 'single repository instance');
});

test('W24P3-12. NO writes / NO SQL / NO controller execution during construction', () => {
  const db = fakeDb();
  // wrap a controller method to detect any execution
  let controllerCalls = 0;
  const origCreate = controller.create;
  controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
  try {
    A.createPersistenceHandler({ db });
    A.getPersistenceBinding(db);
    assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all during construction');
    assert.equal(controllerCalls, 0, 'no controller method executed during construction');
  } finally {
    controller.create = origCreate;
  }
});

test('W24P3-13. createPersistenceHandler returns a FRESH object with fresh binding/handler/status; controller ref shared', () => {
  const a = A.createPersistenceHandler();
  const b = A.createPersistenceHandler();
  assert.notEqual(a, b);
  assert.notEqual(a.binding, b.binding);
  assert.notEqual(a.handler, b.handler);
  assert.notEqual(a.status, b.status);
  assert.equal(a.handler.controller, b.handler.controller); // shared existing module reference
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P3-14. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(A.getStatus(), { enabled: false, ...STATUS });
  });
  const a = A.getStatus();
  const b = A.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(A.getStatus().mode, 'FOUNDATION');
});

test('W24P3-15. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(A.health(), { ready: true, enabled: false, handlerAdapterAvailable: true });
  });
  const a = A.health();
  const b = A.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(A.health().ready, true);
});

test('W24P3-16. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = A.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'persistence-handler-adapter', 'persistence-controller-binding', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = A.capabilities();
  const b = A.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(A.capabilities()[0].available, true);
});

test('W24P3-17. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-24 Phase 4', description: 'Controlled Guarded Route Mount (staging only)', productionImpact: false,
  });
  const a = A.getNextPhase();
  const b = A.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(A.getNextPhase().phase, 'WP-24 Phase 4');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P3-18. deterministic (fixed env); never throws under hostile/frozen args; flag-enabled changes nothing structural', () => {
  withUnset(() => {
    assert.deepEqual(A.getStatus(), A.getStatus());
    assert.deepEqual(A.createPersistenceHandler(), A.createPersistenceHandler());
    assert.deepEqual(A.capabilities(), A.capabilities());
    assert.deepEqual(A.getNextPhase(), A.getNextPhase());
    const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
    for (const h of hostile) {
      for (const k of Object.keys(A)) noThrow(() => A[k](h, h, h), `A.${k}`);
    }
  });
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const h = A.createPersistenceHandler();
    assert.equal(h.enabled, true);
    assert.equal(h.handler.executable, false); // still not executable
    assert.equal(h.status.mounted, false);
    assert.equal(h.status.registered, false);
    assert.equal(h.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P3-19. imports ONLY the allowed pair, no Express/HTTP/server, and reads no env itself', () => {
  const src = fs.readFileSync(path.join(EDIR, 'persistence-handler-adapter.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./persistence-controller-binding', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration');
});

test('W24P3-20. handler adapter is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
