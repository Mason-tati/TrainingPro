// WP-24 · Phase 5 — Enterprise Document Engine Controlled Express Mount Descriptor tests.
// Verifies the module resolves the WP-24 Phase 4 activation and prepares an inert Express mount
// descriptor (ready:true, mounted:false, executed:false, registered:false) reusing the existing
// activation/handler/controller/services (same repository instances), while: enabled derives from
// ./runtime-feature-flag (OFF by default); NO writes/SQL, NO controller/handler/activation execution
// during construction; no route registration/Express/HTTP; only runtime-feature-flag reads env;
// copy-on-read; determinism; never throws; and the module remains unreachable (unwired).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'express-mount-descriptor.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const liveHandlerActivationAdapter = require(path.join(EDIR, 'live-handler-activation-adapter.js'));
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
  handlerReady: true, activationReady: true, mountReady: true, bound: true, composed: true,
  wired: false, registered: false, mounted: false, active: false, executed: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P5-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'createExpressMountDescriptor', 'getActivation', 'getNextPhase', 'getStatus', 'health', 'isMountDescriptorEnabled',
  ]);
});

test('W24P5-2. every export is a function', () => {
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P5-3. isMountDescriptorEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(M.isMountDescriptorEnabled(), false);
    assert.equal(M.isMountDescriptorEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P5-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    M.createExpressMountDescriptor();
    M.getActivation();
    M.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(M.isMountDescriptorEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getActivation — delegates to the Phase 4 adapter
// ---------------------------------------------------------------------------

test('W24P5-5. getActivation delegates to live-handler-activation-adapter.createLiveHandlerActivation()', () => {
  const act = M.getActivation();
  assert.deepEqual(Object.keys(act).sort(), ['activation', 'enabled', 'persistenceHandler', 'status']);
  assert.deepEqual(Object.keys(act).sort(), Object.keys(liveHandlerActivationAdapter.createLiveHandlerActivation()).sort());
  assert.equal(act.activation.active, false);
});

test('W24P5-6. getActivation returns a FRESH activation every call', () => {
  const a = M.getActivation();
  const b = M.getActivation();
  assert.notEqual(a, b);
  assert.notEqual(a.activation, b.activation);
});

test('W24P5-7. getActivation(db) injects the handle through to the services (DB handle reuse)', () => {
  const db = fakeDb();
  const act = M.getActivation(db);
  assert.equal(act.activation.services.documentService.repository.db, db);
});

// ---------------------------------------------------------------------------
// createExpressMountDescriptor — the inert mount descriptor
// ---------------------------------------------------------------------------

test('W24P5-8. createExpressMountDescriptor returns the expected shape', () => {
  withUnset(() => {
    const d = M.createExpressMountDescriptor();
    assert.deepEqual(Object.keys(d).sort(), ['activation', 'enabled', 'mount', 'status']);
    assert.equal(d.enabled, false);
    assert.deepEqual(d.status, { enabled: false, ...STATUS });
    assert.deepEqual(Object.keys(d.mount).sort(), ['controller', 'executed', 'handler', 'mounted', 'ready', 'registered', 'services']);
  });
});

test('W24P5-9. mount descriptor: ready true, mounted false, executed false, registered false', () => {
  const d = M.createExpressMountDescriptor();
  assert.equal(d.mount.ready, true);
  assert.equal(d.mount.mounted, false);
  assert.equal(d.mount.executed, false);
  assert.equal(d.mount.registered, false);
});

test('W24P5-10. status: all readiness flags true, all runtime flags false', () => {
  withUnset(() => {
    const s = M.createExpressMountDescriptor().status;
    for (const t of ['handlerReady', 'activationReady', 'mountReady', 'bound', 'composed']) assert.equal(s[t], true, `${t} true`);
    for (const f of ['enabled', 'wired', 'registered', 'mounted', 'active', 'executed', 'production']) assert.equal(s[f], false, `${f} false`);
    assert.equal(s.mode, 'FOUNDATION');
  });
});

test('W24P5-11. reuses the existing activation + handler + controller + services (not duplicated)', () => {
  const d = M.createExpressMountDescriptor();
  assert.equal(d.mount.handler, d.activation.activation.handler, 'reuses the handler descriptor');
  assert.equal(d.mount.controller, controller, 'reuses the existing controller');
  assert.equal(d.mount.services, d.activation.activation.services, 'reuses the bound services (same instances)');
});

test('W24P5-12. repository instances reused end-to-end (service → repository → injected handle)', () => {
  const db = fakeDb();
  const d = M.createExpressMountDescriptor({ db });
  assert.equal(d.mount.services.documentService.repository.db, db);
});

test('W24P5-13. NO writes / NO SQL / NO controller/handler/activation execution during construction', () => {
  const db = fakeDb();
  let controllerCalls = 0;
  const origCreate = controller.create;
  controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
  try {
    M.createExpressMountDescriptor({ db });
    M.getActivation(db);
    assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all during construction');
    assert.equal(controllerCalls, 0, 'no controller method executed');
  } finally {
    controller.create = origCreate;
  }
});

test('W24P5-14. createExpressMountDescriptor returns a FRESH object with fresh mount/status; controller ref shared', () => {
  const a = M.createExpressMountDescriptor();
  const b = M.createExpressMountDescriptor();
  assert.notEqual(a, b);
  assert.notEqual(a.mount, b.mount);
  assert.notEqual(a.status, b.status);
  assert.equal(a.mount.controller, b.mount.controller); // shared existing module reference
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P5-15. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(M.getStatus(), { enabled: false, ...STATUS });
  });
  const a = M.getStatus();
  const b = M.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(M.getStatus().mode, 'FOUNDATION');
});

test('W24P5-16. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(M.health(), { ready: true, enabled: false, mountDescriptorAvailable: true });
  });
  const a = M.health();
  const b = M.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(M.health().ready, true);
});

test('W24P5-17. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = M.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'express-mount-descriptor', 'live-handler-activation-adapter', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = M.capabilities();
  const b = M.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(M.capabilities()[0].available, true);
});

test('W24P5-18. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(M.getNextPhase(), {
    phase: 'WP-24 Phase 6', description: 'Controlled Guarded Route Mount (staging only)', productionImpact: false,
  });
  const a = M.getNextPhase();
  const b = M.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(M.getNextPhase().phase, 'WP-24 Phase 6');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P5-19. deterministic (fixed env); never throws; flag-enabled keeps mounted/executed false and route stack unchanged', () => {
  withUnset(() => {
    assert.deepEqual(M.getStatus(), M.getStatus());
    assert.deepEqual(M.createExpressMountDescriptor(), M.createExpressMountDescriptor());
    assert.deepEqual(M.capabilities(), M.capabilities());
    assert.deepEqual(M.getNextPhase(), M.getNextPhase());
    const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
    for (const h of hostile) {
      for (const k of Object.keys(M)) noThrow(() => M[k](h, h, h), `M.${k}`);
    }
  });
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const d = M.createExpressMountDescriptor();
    assert.equal(d.enabled, true);
    assert.equal(d.mount.mounted, false); // still not mounted
    assert.equal(d.mount.executed, false); // still not executed
    assert.equal(d.mount.registered, false); // still not registered
    assert.equal(d.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P5-20. imports ONLY the allowed pair (no Express/HTTP/server), reads no env, and is UNWIRED', () => {
  const src = fs.readFileSync(path.join(EDIR, 'express-mount-descriptor.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./live-handler-activation-adapter', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration');
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
