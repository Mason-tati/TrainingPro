// WP-24 · Phase 1 — Enterprise Document Engine Controlled Persistence Bridge tests.
// Verifies the bridge assembles the WP-21 persistence composition (repositories + services over the
// shared DB handle) joined with the WP-19 API layer, while: enabled derives from
// ./runtime-feature-flag (OFF by default); repositories/services are injected with the SAME handle
// (reuse, no duplicate instances); NO writes/SQL run during construction; no route registration/
// Express/server; only runtime-feature-flag reads env; copy-on-read; determinism; never throws; and
// the bridge remains unreachable (unwired).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const B = require(path.join(EDIR, 'production-composition-bridge.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const wiring = require(path.join(EDIR, 'wiring.js'));
const controller = require(path.join(EDIR, 'controller.js'));
const apiAdapter = require(path.join(EDIR, 'api-adapter.js'));
const repositoryAdapter = require(path.join(EDIR, 'repository-adapter.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

// A fake sqlite3 connection with call counters — satisfies BaseRepository (run/get/all) but records
// any query attempt so we can prove construction performs no writes/SQL.
function fakeDb() {
  const calls = { run: 0, get: 0, all: 0 };
  return {
    calls,
    run(...a) { calls.run += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb.call({ lastID: 0, changes: 0 }, null); },
    get(...a) { calls.get += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, null); },
    all(...a) { calls.all += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, []); },
  };
}

const STATUS = { bridged: true, composed: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION' };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P1-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(B).sort(), [
    'capabilities', 'createProductionCompositionBridge', 'getComposition', 'getNextPhase', 'getStatus', 'health', 'isBridgeEnabled',
  ]);
});

test('W24P1-2. every export is a function', () => {
  for (const k of Object.keys(B)) assert.equal(typeof B[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P1-3. isBridgeEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(B.isBridgeEnabled(), false);
    assert.equal(B.isBridgeEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P1-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    B.createProductionCompositionBridge();
    B.getComposition();
    B.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(B.isBridgeEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getComposition — reuses wiring (no duplicated composition)
// ---------------------------------------------------------------------------

test('W24P1-5. getComposition delegates to wiring.createComposition() with the expected shape', () => {
  const comp = B.getComposition();
  assert.deepEqual(Object.keys(comp).sort(), ['db', 'enabled', 'repositories', 'services', 'status']);
  assert.deepEqual(Object.keys(comp).sort(), Object.keys(wiring.createComposition()).sort());
});

test('W24P1-6. getComposition returns a FRESH composition every call (fresh repositories/services)', () => {
  const a = B.getComposition();
  const b = B.getComposition();
  assert.notEqual(a, b);
  assert.notEqual(a.repositories, b.repositories);
  assert.notEqual(a.services, b.services);
});

test('W24P1-7. getComposition(db) injects the handle → repositories built with it (DB handle reuse)', () => {
  const db = fakeDb();
  const comp = B.getComposition(db);
  assert.equal(comp.db, db, 'composition.db is the injected handle');
  assert.ok(comp.repositories.documentRepository, 'documentRepository constructed');
  assert.equal(comp.repositories.documentRepository.db, db, 'repository holds the SAME injected handle (reuse)');
});

// ---------------------------------------------------------------------------
// createProductionCompositionBridge — the full integration object
// ---------------------------------------------------------------------------

test('W24P1-8. createProductionCompositionBridge returns the expected shape (persistence + API + status)', () => {
  withUnset(() => {
    const bridge = B.createProductionCompositionBridge();
    assert.deepEqual(Object.keys(bridge).sort(), ['api', 'composition', 'enabled', 'status']);
    assert.equal(bridge.enabled, false);
    assert.deepEqual(bridge.status, STATUS);
    assert.deepEqual(Object.keys(bridge.composition).sort(), ['db', 'enabled', 'repositories', 'services', 'status']);
    assert.deepEqual(Object.keys(bridge.api).sort(), ['apiAdapter', 'controller', 'repositoryAdapter']);
  });
});

test('W24P1-9. bridge exposes the EXISTING API layer (reused references, not duplicates)', () => {
  const bridge = B.createProductionCompositionBridge();
  assert.equal(bridge.api.controller, controller);
  assert.equal(bridge.api.apiAdapter, apiAdapter);
  assert.equal(bridge.api.repositoryAdapter, repositoryAdapter);
  assert.equal(typeof bridge.api.controller.create, 'function'); // WP-19 controller surface intact
});

test('W24P1-10. repository + service injection: services hold the same repository instances (no duplicate composition)', () => {
  const db = fakeDb();
  const bridge = B.createProductionCompositionBridge({ db });
  const { repositories, services } = bridge.composition;
  assert.equal(bridge.composition.db, db, 'DB handle reused');
  assert.ok(services.documentService && repositories.documentRepository);
  assert.equal(services.documentService.repository, repositories.documentRepository, 'service reuses the composed repository (no second instance)');
  assert.equal(repositories.documentRepository.db, db, 'repository built over the injected handle');
});

test('W24P1-11. NO writes / NO SQL during construction (injected handle is never queried)', () => {
  const db = fakeDb();
  B.createProductionCompositionBridge({ db });
  B.getComposition(db);
  assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all invoked while composing');
});

test('W24P1-12. createProductionCompositionBridge returns a FRESH object with fresh composition/status; API refs shared', () => {
  const a = B.createProductionCompositionBridge();
  const b = B.createProductionCompositionBridge();
  assert.notEqual(a, b);
  assert.notEqual(a.composition, b.composition);
  assert.notEqual(a.status, b.status);
  assert.notEqual(a.api, b.api);
  assert.equal(a.api.controller, b.api.controller); // shared existing module reference
});

test('W24P1-13. never opens a database directly: with the DB uninitialised, composition.db is null and it never throws', () => {
  // default path (no injected db) delegates to wiring → getDb(); uninitialised in this process
  noThrow(() => B.createProductionCompositionBridge(), 'createProductionCompositionBridge()');
  const comp = B.getComposition();
  assert.equal(comp.db, null, 'no direct connection opened (null handle when uninitialised)');
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P1-14. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(B.getStatus(), { enabled: false, ...STATUS });
  });
  const a = B.getStatus();
  const b = B.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(B.getStatus().mode, 'FOUNDATION');
});

test('W24P1-15. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(B.health(), { ready: true, enabled: false, compositionBridgeAvailable: true });
  });
  const a = B.health();
  const b = B.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(B.health().ready, true);
});

test('W24P1-16. capabilities returns five fresh entries (copy-on-read)', () => {
  const caps = B.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-composition-bridge', 'wiring', 'controller', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = B.capabilities();
  const b = B.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(B.capabilities()[0].available, true);
});

test('W24P1-17. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(B.getNextPhase(), {
    phase: 'WP-24 Phase 2', description: 'Controlled Persistence-Backed Controller Binding', productionImpact: false,
  });
  const a = B.getNextPhase();
  const b = B.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(B.getNextPhase().phase, 'WP-24 Phase 2');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P1-18. deterministic (fixed env); never throws under hostile/frozen args; flag-enabled changes nothing structural', () => {
  withUnset(() => {
    assert.deepEqual(B.getStatus(), B.getStatus());
    assert.deepEqual(B.createProductionCompositionBridge(), B.createProductionCompositionBridge());
    assert.deepEqual(B.capabilities(), B.capabilities());
    assert.deepEqual(B.getNextPhase(), B.getNextPhase());
    const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
    for (const h of hostile) {
      for (const k of Object.keys(B)) noThrow(() => B[k](h, h, h), `B.${k}`);
    }
  });
  // even with the flag ON, the bridge mounts/registers nothing and the route stack is unchanged
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const bridge = B.createProductionCompositionBridge();
    assert.equal(bridge.enabled, true);
    assert.equal(bridge.status.mounted, false);
    assert.equal(bridge.status.registered, false);
    assert.equal(bridge.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P1-19. imports ONLY existing engine modules, no Express/server, and reads no env itself', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-composition-bridge.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./api-adapter', './controller', './repository-adapter', './runtime-feature-flag', './wiring']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import (reuses wiring)');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration');
});

test('W24P1-20. composition bridge is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
