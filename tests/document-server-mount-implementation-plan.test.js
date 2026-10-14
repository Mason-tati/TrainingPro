// WP-23 · Phase 2 — Enterprise Document Engine Controlled Server Mount Implementation Planning tests.
// Verifies the module: exact export surface; enabled derives from ./runtime-feature-flag (OFF while
// DOCUMENT_ENGINE_ENABLED unset); the WP-23 Phase 1 coordinator is delegated fresh;
// createMountImplementationPlan assembles enabled/coordinator/status (planned/coordinated/prepared/
// validated true, implemented/wired/registered/mounted/production false); next-phase; copy-on-read;
// determinism; never throws; imports ONLY the allowed pair; performs no process.env/Express/mount;
// route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const P = require(path.join(EDIR, 'server-mount-implementation-plan.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const productionIntegrationCoordinator = require(path.join(EDIR, 'production-integration-coordinator.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  planned: true, coordinated: true, prepared: true, validated: true,
  implemented: false, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23P2-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(P).sort(), [
    'capabilities', 'createMountImplementationPlan', 'getCoordinator', 'getNextPhase', 'getStatus', 'health', 'isMountImplementationPlanned',
  ]);
});

test('W23P2-2. every export is a function', () => {
  for (const k of Object.keys(P)) assert.equal(typeof P[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23P2-3. isMountImplementationPlanned derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(P.isMountImplementationPlanned(), false);
    assert.equal(P.isMountImplementationPlanned(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23P2-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    P.createMountImplementationPlan();
    P.getCoordinator();
    P.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(P.isMountImplementationPlanned(), false);
  });
});

// ---------------------------------------------------------------------------
// getCoordinator
// ---------------------------------------------------------------------------

test('W23P2-5. getCoordinator delegates to production-integration-coordinator.createCoordinator()', () => {
  const co = P.getCoordinator();
  assert.deepEqual(Object.keys(co).sort(), ['enabled', 'goLiveReport', 'status']);
  assert.equal(co.status.coordinated, true);
  assert.equal(co.status.wired, false);
});

test('W23P2-6. getCoordinator returns a FRESH object every call', () => {
  const a = P.getCoordinator();
  const b = P.getCoordinator();
  assert.notEqual(a, b);
  assert.notEqual(a.goLiveReport, b.goLiveReport);
});

test('W23P2-7. getCoordinator is consistent with production-integration-coordinator directly', () => {
  assert.deepEqual(Object.keys(P.getCoordinator()).sort(), Object.keys(productionIntegrationCoordinator.createCoordinator()).sort());
});

// ---------------------------------------------------------------------------
// createMountImplementationPlan
// ---------------------------------------------------------------------------

test('W23P2-8. createMountImplementationPlan returns the expected shape', () => {
  withUnset(() => {
    const plan = P.createMountImplementationPlan();
    assert.deepEqual(Object.keys(plan).sort(), ['coordinator', 'enabled', 'status']);
    assert.equal(plan.enabled, false);
    assert.deepEqual(plan.status, STATUS);
    assert.deepEqual(Object.keys(plan.coordinator).sort(), ['enabled', 'goLiveReport', 'status']);
  });
});

test('W23P2-9. createMountImplementationPlan wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const plan = P.createMountImplementationPlan();
  const chain = plan.coordinator.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23P2-10. createMountImplementationPlan: planned/coordinated/prepared/validated true, implemented/wired/registered/mounted/production false, mounts nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const plan = P.createMountImplementationPlan();
  assert.equal(plan.status.planned, true);
  assert.equal(plan.status.coordinated, true);
  assert.equal(plan.status.prepared, true);
  assert.equal(plan.status.validated, true);
  assert.equal(plan.status.implemented, false);
  assert.equal(plan.status.wired, false);
  assert.equal(plan.status.registered, false);
  assert.equal(plan.status.mounted, false);
  assert.equal(plan.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing mounted');
});

test('W23P2-11. createMountImplementationPlan returns a FRESH object with fresh coordinator/status every call', () => {
  const a = P.createMountImplementationPlan();
  const b = P.createMountImplementationPlan();
  assert.notEqual(a, b);
  assert.notEqual(a.coordinator, b.coordinator);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23P2-12. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(P.getStatus(), { enabled: false, ...STATUS });
  });
  const a = P.getStatus();
  const b = P.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(P.getStatus().mode, 'FOUNDATION');
});

test('W23P2-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(P.health(), { ready: true, enabled: false, planningAvailable: true });
  });
  const a = P.health();
  const b = P.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(P.health().ready, true);
});

test('W23P2-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = P.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'server-mount-implementation-plan', 'production-integration-coordinator', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = P.capabilities();
  const b = P.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(P.capabilities()[0].available, true);
});

test('W23P2-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(P.getNextPhase(), {
    phase: 'WP-23 Phase 3', description: 'Controlled Express Mount Adapter', productionImpact: false,
  });
  const a = P.getNextPhase();
  const b = P.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(P.getNextPhase().phase, 'WP-23 Phase 3');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23P2-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(P.isMountImplementationPlanned(), P.isMountImplementationPlanned());
    assert.deepEqual(P.getCoordinator(), P.getCoordinator());
    assert.deepEqual(P.createMountImplementationPlan(), P.createMountImplementationPlan());
    assert.deepEqual(P.getStatus(), P.getStatus());
    assert.deepEqual(P.health(), P.health());
    assert.deepEqual(P.capabilities(), P.capabilities());
    assert.deepEqual(P.getNextPhase(), P.getNextPhase());
  });
});

test('W23P2-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(P)) noThrow(() => P[k](h, h, h), `P.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', mounted: true });
    assert.equal(P.isMountImplementationPlanned(frozen), false);
    assert.equal(P.getStatus(frozen).mounted, false);
    assert.equal(P.createMountImplementationPlan(frozen).status.mounted, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', mounted: true });
  });
});

test('W23P2-18. runtime flag enabled still never mounts anything (route stack unchanged); implemented/production stay OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const plan = P.createMountImplementationPlan();
    assert.equal(plan.enabled, true); // derives from runtime flag
    assert.equal(plan.status.planned, true);
    assert.equal(plan.status.implemented, false); // still never implemented
    assert.equal(plan.status.wired, false);
    assert.equal(plan.status.mounted, false); // still never mounted
    assert.equal(plan.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23P2-19. imports ONLY ./runtime-feature-flag + ./production-integration-coordinator and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-mount-implementation-plan.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-integration-coordinator', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/mount/server wiring');
});

test('W23P2-20. mount implementation plan is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
