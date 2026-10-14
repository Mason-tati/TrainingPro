// WP-23 · Phase 3 — Enterprise Document Engine Controlled Express Mount Adapter tests.
// Verifies the adapter: exact export surface; enabled derives from ./runtime-feature-flag (OFF while
// DOCUMENT_ENGINE_ENABLED unset); the WP-23 Phase 2 mount plan is delegated fresh;
// createExpressMountAdapter assembles enabled/mountImplementationPlan/status (adapted/planned/
// coordinated/prepared/validated true, implemented/wired/registered/mounted/production false);
// next-phase; copy-on-read; determinism; never throws; imports ONLY the allowed pair (no Express);
// performs no process.env/Express/mount; route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'express-mount-adapter.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const serverMountImplementationPlan = require(path.join(EDIR, 'server-mount-implementation-plan.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  adapted: true, planned: true, coordinated: true, prepared: true, validated: true,
  implemented: false, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23P3-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'capabilities', 'createExpressMountAdapter', 'getMountImplementationPlan', 'getNextPhase', 'getStatus', 'health', 'isAdapterEnabled',
  ]);
});

test('W23P3-2. every export is a function', () => {
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23P3-3. isAdapterEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(A.isAdapterEnabled(), false);
    assert.equal(A.isAdapterEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23P3-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    A.createExpressMountAdapter();
    A.getMountImplementationPlan();
    A.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(A.isAdapterEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getMountImplementationPlan
// ---------------------------------------------------------------------------

test('W23P3-5. getMountImplementationPlan delegates to server-mount-implementation-plan.createMountImplementationPlan()', () => {
  const plan = A.getMountImplementationPlan();
  assert.deepEqual(Object.keys(plan).sort(), ['coordinator', 'enabled', 'status']);
  assert.equal(plan.status.planned, true);
  assert.equal(plan.status.mounted, false);
});

test('W23P3-6. getMountImplementationPlan returns a FRESH object every call', () => {
  const a = A.getMountImplementationPlan();
  const b = A.getMountImplementationPlan();
  assert.notEqual(a, b);
  assert.notEqual(a.coordinator, b.coordinator);
});

test('W23P3-7. getMountImplementationPlan is consistent with server-mount-implementation-plan directly', () => {
  assert.deepEqual(Object.keys(A.getMountImplementationPlan()).sort(), Object.keys(serverMountImplementationPlan.createMountImplementationPlan()).sort());
});

// ---------------------------------------------------------------------------
// createExpressMountAdapter
// ---------------------------------------------------------------------------

test('W23P3-8. createExpressMountAdapter returns the expected shape', () => {
  withUnset(() => {
    const ad = A.createExpressMountAdapter();
    assert.deepEqual(Object.keys(ad).sort(), ['enabled', 'mountImplementationPlan', 'status']);
    assert.equal(ad.enabled, false);
    assert.deepEqual(ad.status, STATUS);
    assert.deepEqual(Object.keys(ad.mountImplementationPlan).sort(), ['coordinator', 'enabled', 'status']);
  });
});

test('W23P3-9. createExpressMountAdapter wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const ad = A.createExpressMountAdapter();
  const chain = ad.mountImplementationPlan.coordinator.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23P3-10. createExpressMountAdapter: adapted/planned/coordinated/prepared/validated true, implemented/wired/registered/mounted/production false, mounts nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const ad = A.createExpressMountAdapter();
  assert.equal(ad.status.adapted, true);
  assert.equal(ad.status.planned, true);
  assert.equal(ad.status.coordinated, true);
  assert.equal(ad.status.prepared, true);
  assert.equal(ad.status.validated, true);
  assert.equal(ad.status.implemented, false);
  assert.equal(ad.status.wired, false);
  assert.equal(ad.status.registered, false);
  assert.equal(ad.status.mounted, false);
  assert.equal(ad.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing mounted');
});

test('W23P3-11. createExpressMountAdapter returns a FRESH object with fresh plan/status every call', () => {
  const a = A.createExpressMountAdapter();
  const b = A.createExpressMountAdapter();
  assert.notEqual(a, b);
  assert.notEqual(a.mountImplementationPlan, b.mountImplementationPlan);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23P3-12. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(A.getStatus(), { enabled: false, ...STATUS });
  });
  const a = A.getStatus();
  const b = A.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(A.getStatus().mode, 'FOUNDATION');
});

test('W23P3-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(A.health(), { ready: true, enabled: false, adapterAvailable: true });
  });
  const a = A.health();
  const b = A.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(A.health().ready, true);
});

test('W23P3-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = A.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'express-mount-adapter', 'server-mount-implementation-plan', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = A.capabilities();
  const b = A.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(A.capabilities()[0].available, true);
});

test('W23P3-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-23 Phase 4', description: 'Controlled Express Registration Adapter', productionImpact: false,
  });
  const a = A.getNextPhase();
  const b = A.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(A.getNextPhase().phase, 'WP-23 Phase 4');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23P3-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(A.isAdapterEnabled(), A.isAdapterEnabled());
    assert.deepEqual(A.getMountImplementationPlan(), A.getMountImplementationPlan());
    assert.deepEqual(A.createExpressMountAdapter(), A.createExpressMountAdapter());
    assert.deepEqual(A.getStatus(), A.getStatus());
    assert.deepEqual(A.health(), A.health());
    assert.deepEqual(A.capabilities(), A.capabilities());
    assert.deepEqual(A.getNextPhase(), A.getNextPhase());
  });
});

test('W23P3-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(A)) noThrow(() => A[k](h, h, h), `A.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', mounted: true });
    assert.equal(A.isAdapterEnabled(frozen), false);
    assert.equal(A.getStatus(frozen).mounted, false);
    assert.equal(A.createExpressMountAdapter(frozen).status.mounted, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', mounted: true });
  });
});

test('W23P3-18. runtime flag enabled still never mounts anything (route stack unchanged); implemented/production stay OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const ad = A.createExpressMountAdapter();
    assert.equal(ad.enabled, true); // derives from runtime flag
    assert.equal(ad.status.adapted, true);
    assert.equal(ad.status.implemented, false); // still never implemented
    assert.equal(ad.status.wired, false);
    assert.equal(ad.status.mounted, false); // still never mounted
    assert.equal(ad.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23P3-19. imports ONLY the allowed pair, does NOT import Express, and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'express-mount-adapter.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-mount-implementation-plan']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/mount/server wiring');
});

test('W23P3-20. express mount adapter is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
