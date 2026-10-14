// WP-24 · Phase 4 — Enterprise Document Engine Controlled Live Handler Activation Adapter tests.
// Verifies the adapter resolves the WP-24 Phase 3 handler and prepares an inert activation
// descriptor (ready:true, active:false, executed:false) reusing the existing handler/controller/
// services (same repository instances), while: enabled derives from ./runtime-feature-flag (OFF by
// default); NO writes/SQL, NO controller execution, NO handler execution during construction; no
// route registration/Express/HTTP; only runtime-feature-flag reads env; copy-on-read; determinism;
// never throws; and the adapter remains unreachable (unwired).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'live-handler-activation-adapter.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const persistenceHandlerAdapter = require(path.join(EDIR, 'persistence-handler-adapter.js'));
const controller = require(path.join(EDIR, 'controller.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

function fakeDb() {
  const calls = { run: 0, get: 0, all: 0 };
  return {
    calls,
    run(...a) { calls.run += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb.call({ lastID: 0, changes: 0 }, null); },
    get(...a) { calls.get += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, null); },
    all(...a) { calls.all += 1; const cb = a[a.length - 1]; if (typeof cb === 'function') cb(null, []); },
  };
}

const STATUS = {
  handlerReady: true, activationReady: true, bound: true, composed: true,
  wired: false, registered: false, mounted: false, active: false, executed: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P4-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'capabilities', 'createLiveHandlerActivation', 'getNextPhase', 'getPersistenceHandler', 'getStatus', 'health', 'isActivationEnabled',
  ]);
});

test('W24P4-2. every export is a function', () => {
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P4-3. isActivationEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(A.isActivationEnabled(), false);
    assert.equal(A.isActivationEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P4-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    A.createLiveHandlerActivation();
    A.getPersistenceHandler();
    A.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(A.isActivationEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getPersistenceHandler — delegates to the Phase 3 adapter
// ---------------------------------------------------------------------------

test('W24P4-5. getPersistenceHandler delegates to persistence-handler-adapter.createPersistenceHandler()', () => {
  const ph = A.getPersistenceHandler();
  assert.deepEqual(Object.keys(ph).sort(), ['binding', 'enabled', 'handler', 'status']);
  assert.deepEqual(Object.keys(ph).sort(), Object.keys(persistenceHandlerAdapter.createPersistenceHandler()).sort());
  assert.equal(ph.handler.executable, false);
});

test('W24P4-6. getPersistenceHandler returns a FRESH handler every call', () => {
  const a = A.getPersistenceHandler();
  const b = A.getPersistenceHandler();
  assert.notEqual(a, b);
  assert.notEqual(a.handler, b.handler);
});

test('W24P4-7. getPersistenceHandler(db) injects the handle through to the services (DB handle reuse)', () => {
  const db = fakeDb();
  const ph = A.getPersistenceHandler(db);
  assert.equal(ph.handler.services.documentService.repository.db, db);
});

// ---------------------------------------------------------------------------
// createLiveHandlerActivation — the inert activation descriptor
// ---------------------------------------------------------------------------

test('W24P4-8. createLiveHandlerActivation returns the expected shape', () => {
  withUnset(() => {
    const a = A.createLiveHandlerActivation();
    assert.deepEqual(Object.keys(a).sort(), ['activation', 'enabled', 'persistenceHandler', 'status']);
    assert.equal(a.enabled, false);
    assert.deepEqual(a.status, { enabled: false, ...STATUS });
    assert.deepEqual(Object.keys(a.activation).sort(), ['active', 'controller', 'executed', 'handler', 'ready', 'services']);
  });
});

test('W24P4-9. activation descriptor: ready true, active false, executed false', () => {
  const a = A.createLiveHandlerActivation();
  assert.equal(a.activation.ready, true);
  assert.equal(a.activation.active, false);
  assert.equal(a.activation.executed, false);
});

test('W24P4-10. status: all readiness flags true, all runtime flags false', () => {
  withUnset(() => {
    const s = A.createLiveHandlerActivation().status;
    for (const t of ['handlerReady', 'activationReady', 'bound', 'composed']) assert.equal(s[t], true, `${t} true`);
    for (const f of ['enabled', 'wired', 'registered', 'mounted', 'active', 'executed', 'production']) assert.equal(s[f], false, `${f} false`);
    assert.equal(s.mode, 'FOUNDATION');
  });
});

test('W24P4-11. reuses the existing handler + controller + services (not duplicated)', () => {
  const a = A.createLiveHandlerActivation();
  assert.equal(a.activation.handler, a.persistenceHandler.handler, 'reuses the handler descriptor');
  assert.equal(a.activation.controller, controller, 'reuses the existing controller');
  assert.equal(a.activation.services, a.persistenceHandler.handler.services, 'reuses the bound services (same instances)');
});

test('W24P4-12. repository instances reused end-to-end (service → repository → injected handle)', () => {
  const db = fakeDb();
  const a = A.createLiveHandlerActivation({ db });
  assert.equal(a.activation.services.documentService.repository.db, db);
});

test('W24P4-13. NO writes / NO SQL / NO controller execution / NO handler execution during construction', () => {
  const db = fakeDb();
  let controllerCalls = 0;
  const origCreate = controller.create;
  controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
  try {
    A.createLiveHandlerActivation({ db });
    A.getPersistenceHandler(db);
    assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all during construction');
    assert.equal(controllerCalls, 0, 'no controller method executed');
  } finally {
    controller.create = origCreate;
  }
});

test('W24P4-14. createLiveHandlerActivation returns a FRESH object with fresh activation/status; controller ref shared', () => {
  const a = A.createLiveHandlerActivation();
  const b = A.createLiveHandlerActivation();
  assert.notEqual(a, b);
  assert.notEqual(a.activation, b.activation);
  assert.notEqual(a.status, b.status);
  assert.equal(a.activation.controller, b.activation.controller); // shared existing module reference
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P4-15. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(A.getStatus(), { enabled: false, ...STATUS });
  });
  const a = A.getStatus();
  const b = A.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(A.getStatus().mode, 'FOUNDATION');
});

test('W24P4-16. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(A.health(), { ready: true, enabled: false, activationAdapterAvailable: true });
  });
  const a = A.health();
  const b = A.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(A.health().ready, true);
});

test('W24P4-17. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = A.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'live-handler-activation-adapter', 'persistence-handler-adapter', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = A.capabilities();
  const b = A.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(A.capabilities()[0].available, true);
});

test('W24P4-18. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-24 Phase 5', description: 'Controlled Guarded Route Mount (staging only)', productionImpact: false,
  });
  const a = A.getNextPhase();
  const b = A.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(A.getNextPhase().phase, 'WP-24 Phase 5');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P4-19. deterministic (fixed env); never throws; flag-enabled keeps active/executed false and route stack unchanged', () => {
  withUnset(() => {
    assert.deepEqual(A.getStatus(), A.getStatus());
    assert.deepEqual(A.createLiveHandlerActivation(), A.createLiveHandlerActivation());
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
    const a = A.createLiveHandlerActivation();
    assert.equal(a.enabled, true);
    assert.equal(a.activation.active, false); // still not active
    assert.equal(a.activation.executed, false); // still not executed
    assert.equal(a.status.mounted, false);
    assert.equal(a.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P4-20. imports ONLY the allowed pair (no Express/HTTP/server), reads no env, and is UNWIRED', () => {
  const src = fs.readFileSync(path.join(EDIR, 'live-handler-activation-adapter.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./persistence-handler-adapter', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration');
  // unwired
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
