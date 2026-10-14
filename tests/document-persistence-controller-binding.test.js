// WP-24 · Phase 2 — Enterprise Document Engine Controlled Persistence-Backed Controller Binding tests.
// Verifies the binding pairs the EXISTING WP-19 controller (reused reference, not duplicated) with
// the persistence services RESOLVED from the WP-24 Phase 1 bridge (same repository/service instances
// — no duplicate composition), while: enabled derives from ./runtime-feature-flag (OFF by default);
// NO writes/SQL run during construction; no route registration/Express/server; only
// runtime-feature-flag reads env; copy-on-read; determinism; never throws; controller surface
// unchanged; and the binding remains unreachable (unwired).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const B = require(path.join(EDIR, 'persistence-controller-binding.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const productionCompositionBridge = require(path.join(EDIR, 'production-composition-bridge.js'));
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

const STATUS = { bound: true, composed: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION' };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P2-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(B).sort(), [
    'capabilities', 'createPersistenceControllerBinding', 'getBinding', 'getNextPhase', 'getStatus', 'health', 'isBindingEnabled',
  ]);
});

test('W24P2-2. every export is a function', () => {
  for (const k of Object.keys(B)) assert.equal(typeof B[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P2-3. isBindingEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(B.isBindingEnabled(), false);
    assert.equal(B.isBindingEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P2-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    B.createPersistenceControllerBinding();
    B.getBinding();
    B.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(B.isBindingEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getBinding — delegates to the Phase 1 bridge (source of services)
// ---------------------------------------------------------------------------

test('W24P2-5. getBinding delegates to production-composition-bridge.createProductionCompositionBridge()', () => {
  const bridge = B.getBinding();
  assert.deepEqual(Object.keys(bridge).sort(), ['api', 'composition', 'enabled', 'status']);
  assert.deepEqual(Object.keys(bridge).sort(), Object.keys(productionCompositionBridge.createProductionCompositionBridge()).sort());
});

test('W24P2-6. getBinding returns a FRESH bridge every call', () => {
  const a = B.getBinding();
  const b = B.getBinding();
  assert.notEqual(a, b);
  assert.notEqual(a.composition, b.composition);
});

test('W24P2-7. getBinding(db) injects the handle through to the composition (DB handle reuse)', () => {
  const db = fakeDb();
  const bridge = B.getBinding(db);
  assert.equal(bridge.composition.db, db);
  assert.equal(bridge.composition.repositories.documentRepository.db, db, 'repository holds the injected handle');
});

// ---------------------------------------------------------------------------
// createPersistenceControllerBinding — controller ⇄ persistence services
// ---------------------------------------------------------------------------

test('W24P2-8. createPersistenceControllerBinding returns the expected shape (controller + services + status)', () => {
  withUnset(() => {
    const binding = B.createPersistenceControllerBinding();
    assert.deepEqual(Object.keys(binding).sort(), ['controller', 'enabled', 'services', 'status']);
    assert.equal(binding.enabled, false);
    assert.deepEqual(binding.status, STATUS);
  });
});

test('W24P2-9. binding reuses the EXISTING controller (same reference, surface intact — behaviour unchanged)', () => {
  const before = Object.keys(controller).sort();
  const binding = B.createPersistenceControllerBinding();
  assert.equal(binding.controller, controller, 'same controller reference (not duplicated)');
  assert.equal(typeof binding.controller.create, 'function');
  assert.equal(typeof binding.controller.get, 'function');
  assert.deepEqual(Object.keys(controller).sort(), before, 'controller surface unmutated');
});

test('W24P2-10. controller is bound to the injected persistence services (resolved from the bridge)', () => {
  const db = fakeDb();
  const binding = B.createPersistenceControllerBinding({ db });
  assert.ok(binding.services && binding.services.documentService, 'services resolved');
  // same service instances trace back to the injected handle → same composition, not a duplicate
  assert.equal(binding.services.documentService.repository.db, db, 'service → repository → injected handle (reuse)');
});

test('W24P2-11. same repository + service instances reused (no duplicate composition within a binding)', () => {
  const db = fakeDb();
  const bridge = B.getBinding(db);
  const binding = B.createPersistenceControllerBinding({ db });
  // both draw from wiring over the same handle; the service reuses its composed repository
  assert.equal(binding.services.documentService.repository.db, db);
  assert.equal(bridge.composition.services.documentService.repository.db, db);
  assert.equal(binding.services.documentService.repository, // service holds its repository (single instance)
    binding.services.documentService.repository);
});

test('W24P2-12. NO writes / NO SQL during construction (injected handle never queried)', () => {
  const db = fakeDb();
  B.createPersistenceControllerBinding({ db });
  B.getBinding(db);
  assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all invoked while binding');
});

test('W24P2-13. createPersistenceControllerBinding returns a FRESH object with fresh services/status; controller ref shared', () => {
  const a = B.createPersistenceControllerBinding();
  const b = B.createPersistenceControllerBinding();
  assert.notEqual(a, b);
  assert.notEqual(a.services, b.services);
  assert.notEqual(a.status, b.status);
  assert.equal(a.controller, b.controller); // shared existing module reference
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P2-14. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(B.getStatus(), { enabled: false, ...STATUS });
  });
  const a = B.getStatus();
  const b = B.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(B.getStatus().mode, 'FOUNDATION');
});

test('W24P2-15. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(B.health(), { ready: true, enabled: false, controllerBindingAvailable: true });
  });
  const a = B.health();
  const b = B.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(B.health().ready, true);
});

test('W24P2-16. capabilities returns five fresh entries (copy-on-read)', () => {
  const caps = B.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'persistence-controller-binding', 'production-composition-bridge', 'controller', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = B.capabilities();
  const b = B.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(B.capabilities()[0].available, true);
});

test('W24P2-17. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(B.getNextPhase(), {
    phase: 'WP-24 Phase 3', description: 'Controlled Guarded Route Mount (staging only)', productionImpact: false,
  });
  const a = B.getNextPhase();
  const b = B.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(B.getNextPhase().phase, 'WP-24 Phase 3');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P2-18. deterministic (fixed env); never throws under hostile/frozen args; flag-enabled changes nothing structural', () => {
  withUnset(() => {
    assert.deepEqual(B.getStatus(), B.getStatus());
    assert.deepEqual(B.createPersistenceControllerBinding(), B.createPersistenceControllerBinding());
    assert.deepEqual(B.capabilities(), B.capabilities());
    assert.deepEqual(B.getNextPhase(), B.getNextPhase());
    const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
    for (const h of hostile) {
      for (const k of Object.keys(B)) noThrow(() => B[k](h, h, h), `B.${k}`);
    }
  });
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const binding = B.createPersistenceControllerBinding();
    assert.equal(binding.enabled, true);
    assert.equal(binding.status.mounted, false);
    assert.equal(binding.status.registered, false);
    assert.equal(binding.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P2-19. imports ONLY the allowed trio, no Express/server, and reads no env itself', () => {
  const src = fs.readFileSync(path.join(EDIR, 'persistence-controller-binding.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./controller', './production-composition-bridge', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration');
});

test('W24P2-20. binding is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
