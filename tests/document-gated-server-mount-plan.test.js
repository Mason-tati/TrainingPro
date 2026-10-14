// WP-24 · Phase 7 — Enterprise Document Engine Controlled Gated Server Mount Plan tests.
// Verifies the module resolves the WP-24 Phase 6 integration descriptor and prepares an inert gated
// mount plan (ready/gated/planned true; mounted/registered/integrated/executed/production false)
// reusing the existing integration/mount/handler/controller/services (same repository instances),
// while: enabled derives from ./runtime-feature-flag (OFF by default); NO writes/SQL, NO
// controller/handler execution during construction; no route registration/Express/HTTP; only
// runtime-feature-flag reads env; branch-free; copy-on-read; determinism; never throws; unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const P = require(path.join(EDIR, 'gated-server-mount-plan.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const serverIntegrationDescriptor = require(path.join(EDIR, 'server-integration-descriptor.js'));
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
  handlerReady: true, activationReady: true, mountReady: true, integrationReady: true, gated: true, planned: true,
  bound: true, composed: true, wired: false, integrated: false, registered: false, mounted: false, executed: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W24P7-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(P).sort(), [
    'capabilities', 'createGatedServerMountPlan', 'getNextPhase', 'getServerIntegrationDescriptor', 'getStatus', 'health', 'isServerMountPlanned',
  ]);
});

test('W24P7-2. every export is a function', () => {
  for (const k of Object.keys(P)) assert.equal(typeof P[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF by default)
// ---------------------------------------------------------------------------

test('W24P7-3. isServerMountPlanned derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(P.isServerMountPlanned(), false);
    assert.equal(P.isServerMountPlanned(), runtimeFeatureFlag.isEnabled());
  });
});

test('W24P7-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    P.createGatedServerMountPlan();
    P.getServerIntegrationDescriptor();
    P.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(P.isServerMountPlanned(), false);
  });
});

// ---------------------------------------------------------------------------
// getServerIntegrationDescriptor — delegates to the Phase 6 module
// ---------------------------------------------------------------------------

test('W24P7-5. getServerIntegrationDescriptor delegates to server-integration-descriptor.createServerIntegrationDescriptor()', () => {
  const sid = P.getServerIntegrationDescriptor();
  assert.deepEqual(Object.keys(sid).sort(), ['enabled', 'integration', 'mountDescriptor', 'status']);
  assert.deepEqual(Object.keys(sid).sort(), Object.keys(serverIntegrationDescriptor.createServerIntegrationDescriptor()).sort());
  assert.equal(sid.integration.integrated, false);
});

test('W24P7-6. getServerIntegrationDescriptor returns a FRESH descriptor every call', () => {
  const a = P.getServerIntegrationDescriptor();
  const b = P.getServerIntegrationDescriptor();
  assert.notEqual(a, b);
  assert.notEqual(a.integration, b.integration);
});

test('W24P7-7. getServerIntegrationDescriptor({db}) injects the handle through to the services (DB handle reuse)', () => {
  const db = fakeDb();
  const sid = P.getServerIntegrationDescriptor({ db });
  assert.equal(sid.integration.services.documentService.repository.db, db);
});

// ---------------------------------------------------------------------------
// createGatedServerMountPlan — the inert gated mount plan
// ---------------------------------------------------------------------------

test('W24P7-8. createGatedServerMountPlan returns the expected shape', () => {
  withUnset(() => {
    const p = P.createGatedServerMountPlan();
    assert.deepEqual(Object.keys(p).sort(), ['enabled', 'mountPlan', 'serverIntegrationDescriptor', 'status']);
    assert.equal(p.enabled, false);
    assert.deepEqual(p.status, { enabled: false, ...STATUS });
    assert.deepEqual(Object.keys(p.mountPlan).sort(), [
      'controller', 'executed', 'gated', 'handler', 'integrated', 'integration', 'mount', 'mounted', 'planned', 'production', 'ready', 'registered', 'services',
    ]);
  });
});

test('W24P7-9. mountPlan: ready/gated/planned true; mounted/registered/integrated/executed/production false', () => {
  const mp = P.createGatedServerMountPlan().mountPlan;
  assert.equal(mp.ready, true);
  assert.equal(mp.gated, true);
  assert.equal(mp.planned, true);
  assert.equal(mp.mounted, false);
  assert.equal(mp.registered, false);
  assert.equal(mp.integrated, false);
  assert.equal(mp.executed, false);
  assert.equal(mp.production, false);
});

test('W24P7-10. status: all readiness/gate/plan flags true, all runtime flags false', () => {
  withUnset(() => {
    const s = P.createGatedServerMountPlan().status;
    for (const t of ['handlerReady', 'activationReady', 'mountReady', 'integrationReady', 'gated', 'planned', 'bound', 'composed']) assert.equal(s[t], true, `${t} true`);
    for (const f of ['enabled', 'wired', 'integrated', 'registered', 'mounted', 'executed', 'production']) assert.equal(s[f], false, `${f} false`);
    assert.equal(s.mode, 'FOUNDATION');
  });
});

test('W24P7-11. reuses integration + mount + handler + controller + services (not duplicated)', () => {
  const p = P.createGatedServerMountPlan();
  const sid = p.serverIntegrationDescriptor;
  assert.equal(p.mountPlan.integration, sid.integration, 'reuses integration');
  assert.equal(p.mountPlan.mount, sid.integration.mount, 'reuses mount');
  assert.equal(p.mountPlan.handler, sid.integration.handler, 'reuses handler');
  assert.equal(p.mountPlan.controller, controller, 'reuses existing controller');
  assert.equal(p.mountPlan.services, sid.integration.services, 'reuses bound services (same instances)');
});

test('W24P7-12. repository instances reused end-to-end (service → repository → injected handle)', () => {
  const db = fakeDb();
  const p = P.createGatedServerMountPlan({ db });
  assert.equal(p.mountPlan.services.documentService.repository.db, db);
});

test('W24P7-13. NO writes / NO SQL / NO controller/handler execution during construction', () => {
  const db = fakeDb();
  let controllerCalls = 0;
  const origCreate = controller.create;
  controller.create = (...a) => { controllerCalls += 1; return origCreate(...a); };
  try {
    P.createGatedServerMountPlan({ db });
    P.getServerIntegrationDescriptor({ db });
    assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all during construction');
    assert.equal(controllerCalls, 0, 'no controller method executed');
  } finally {
    controller.create = origCreate;
  }
});

test('W24P7-14. createGatedServerMountPlan returns a FRESH object with fresh mountPlan/status; controller ref shared', () => {
  const a = P.createGatedServerMountPlan();
  const b = P.createGatedServerMountPlan();
  assert.notEqual(a, b);
  assert.notEqual(a.mountPlan, b.mountPlan);
  assert.notEqual(a.status, b.status);
  assert.equal(a.mountPlan.controller, b.mountPlan.controller); // shared existing module reference
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W24P7-15. getStatus returns a fresh copy of the status (plus enabled)', () => {
  withUnset(() => {
    assert.deepEqual(P.getStatus(), { enabled: false, ...STATUS });
  });
  const a = P.getStatus();
  const b = P.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(P.getStatus().mode, 'FOUNDATION');
});

test('W24P7-16. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(P.health(), { ready: true, enabled: false, mountPlanningAvailable: true });
  });
  const a = P.health();
  const b = P.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(P.health().ready, true);
});

test('W24P7-17. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = P.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'gated-server-mount-plan', 'server-integration-descriptor', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = P.capabilities();
  const b = P.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(P.capabilities()[0].available, true);
});

test('W24P7-18. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(P.getNextPhase(), {
    phase: 'WP-24 Phase 8', description: 'Controlled Single Server Mount Integration', productionImpact: false,
  });
  const a = P.getNextPhase();
  const b = P.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(P.getNextPhase().phase, 'WP-24 Phase 8');
});

// ---------------------------------------------------------------------------
// determinism + robustness + flag-enabled safety
// ---------------------------------------------------------------------------

test('W24P7-19. deterministic (fixed env); never throws; flag-enabled keeps mounted/integrated/executed false and route stack unchanged', () => {
  withUnset(() => {
    assert.deepEqual(P.getStatus(), P.getStatus());
    assert.deepEqual(P.createGatedServerMountPlan(), P.createGatedServerMountPlan());
    assert.deepEqual(P.capabilities(), P.capabilities());
    assert.deepEqual(P.getNextPhase(), P.getNextPhase());
    const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
    for (const h of hostile) {
      for (const k of Object.keys(P)) noThrow(() => P[k](h, h, h), `P.${k}`);
    }
  });
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const p = P.createGatedServerMountPlan();
    assert.equal(p.enabled, true);
    assert.equal(p.mountPlan.planned, true);
    assert.equal(p.mountPlan.mounted, false); // still not mounted
    assert.equal(p.mountPlan.integrated, false); // still not integrated
    assert.equal(p.mountPlan.executed, false); // still not executed
    assert.equal(p.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W24P7-20. imports ONLY the allowed pair (no Express/HTTP/server/app.use), reads no env, and is UNWIRED', () => {
  const src = fs.readFileSync(path.join(EDIR, 'gated-server-mount-plan.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-integration-descriptor']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no direct database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/route registration/app.use');
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
