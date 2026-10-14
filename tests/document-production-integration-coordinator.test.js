// WP-23 · Phase 1 — Enterprise Document Engine Production Integration Coordinator tests.
// Verifies the coordinator: exact export surface; enabled derives from ./runtime-feature-flag (OFF
// while DOCUMENT_ENGINE_ENABLED unset); the WP-22 Phase 8 go-live report is delegated fresh;
// createCoordinator assembles enabled/goLiveReport/status (coordinated/prepared/validated/ready true,
// wired/registered/mounted/production false); next-phase; copy-on-read; determinism; never throws;
// imports ONLY the allowed pair; performs no process.env/Express/integration; route stack never
// changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'production-integration-coordinator.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const finalGoLiveReadinessReport = require(path.join(EDIR, 'final-go-live-readiness-report.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// Run `fn` with DOCUMENT_ENGINE_ENABLED unset (restore afterwards).
function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  coordinated: true, prepared: true, validated: true, ready: true,
  wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'createCoordinator', 'getGoLiveReport', 'getNextPhase', 'getStatus', 'health', 'isCoordinatorEnabled',
  ]);
});

test('W23-2. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23-3. isCoordinatorEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(C.isCoordinatorEnabled(), false);
    assert.equal(C.isCoordinatorEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    C.createCoordinator();
    C.getGoLiveReport();
    C.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(C.isCoordinatorEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getGoLiveReport
// ---------------------------------------------------------------------------

test('W23-5. getGoLiveReport delegates to final-go-live-readiness-report.createGoLiveReport()', () => {
  const rep = C.getGoLiveReport();
  assert.deepEqual(Object.keys(rep).sort(), ['enabled', 'productionReadiness', 'status']);
  assert.equal(rep.status.reported, true);
  assert.equal(rep.status.wired, false);
});

test('W23-6. getGoLiveReport returns a FRESH object every call', () => {
  const a = C.getGoLiveReport();
  const b = C.getGoLiveReport();
  assert.notEqual(a, b);
  assert.notEqual(a.productionReadiness, b.productionReadiness);
});

test('W23-7. getGoLiveReport is consistent with final-go-live-readiness-report directly', () => {
  assert.deepEqual(Object.keys(C.getGoLiveReport()).sort(), Object.keys(finalGoLiveReadinessReport.createGoLiveReport()).sort());
});

// ---------------------------------------------------------------------------
// createCoordinator
// ---------------------------------------------------------------------------

test('W23-8. createCoordinator returns the expected shape', () => {
  withUnset(() => {
    const co = C.createCoordinator();
    assert.deepEqual(Object.keys(co).sort(), ['enabled', 'goLiveReport', 'status']);
    assert.equal(co.enabled, false);
    assert.deepEqual(co.status, { enabled: false, ...STATUS });
    assert.deepEqual(Object.keys(co.goLiveReport).sort(), ['enabled', 'productionReadiness', 'status']);
  });
});

test('W23-9. createCoordinator wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const co = C.createCoordinator();
  const chain = co.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23-10. createCoordinator: coordinated/prepared/validated/ready true, wired/registered/mounted/production false, integrates nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const co = C.createCoordinator();
  assert.equal(co.status.coordinated, true);
  assert.equal(co.status.prepared, true);
  assert.equal(co.status.validated, true);
  assert.equal(co.status.ready, true);
  assert.equal(co.status.wired, false);
  assert.equal(co.status.registered, false);
  assert.equal(co.status.mounted, false);
  assert.equal(co.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing integrated');
});

test('W23-11. createCoordinator returns a FRESH object with fresh goLiveReport/status every call', () => {
  const a = C.createCoordinator();
  const b = C.createCoordinator();
  assert.notEqual(a, b);
  assert.notEqual(a.goLiveReport, b.goLiveReport);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23-12. getStatus returns the expected status (all ten fields) + fresh copy', () => {
  withUnset(() => {
    const s = C.getStatus();
    assert.deepEqual(s, { enabled: false, ...STATUS });
    assert.deepEqual(Object.keys(s).sort(), [
      'coordinated', 'enabled', 'mode', 'mounted', 'prepared', 'production', 'ready', 'registered', 'validated', 'wired',
    ]);
  });
  const a = C.getStatus();
  const b = C.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(C.getStatus().mode, 'FOUNDATION');
});

test('W23-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(C.health(), { ready: true, enabled: false, coordinatorAvailable: true });
  });
  const a = C.health();
  const b = C.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(C.health().ready, true);
});

test('W23-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = C.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-integration-coordinator', 'final-go-live-readiness-report', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = C.capabilities();
  const b = C.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(C.capabilities()[0].available, true);
});

test('W23-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(C.getNextPhase(), {
    phase: 'WP-23 Phase 2', description: 'Controlled Production Integration (requires explicit Product Owner approval)', productionImpact: false,
  });
  const a = C.getNextPhase();
  const b = C.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(C.getNextPhase().phase, 'WP-23 Phase 2');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(C.isCoordinatorEnabled(), C.isCoordinatorEnabled());
    assert.deepEqual(C.getGoLiveReport(), C.getGoLiveReport());
    assert.deepEqual(C.createCoordinator(), C.createCoordinator());
    assert.deepEqual(C.getStatus(), C.getStatus());
    assert.deepEqual(C.health(), C.health());
    assert.deepEqual(C.capabilities(), C.capabilities());
    assert.deepEqual(C.getNextPhase(), C.getNextPhase());
  });
});

test('W23-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(C)) noThrow(() => C[k](h, h, h), `C.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', wired: true });
    assert.equal(C.isCoordinatorEnabled(frozen), false);
    assert.equal(C.getStatus(frozen).wired, false);
    assert.equal(C.createCoordinator(frozen).status.wired, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', wired: true });
  });
});

test('W23-18. runtime flag enabled still never integrates anything (route stack unchanged); production stays OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const co = C.createCoordinator();
    assert.equal(co.enabled, true); // derives from runtime flag
    assert.equal(co.status.coordinated, true);
    assert.equal(co.status.wired, false); // still never integrated
    assert.equal(co.status.registered, false);
    assert.equal(co.status.mounted, false);
    assert.equal(co.status.production, false); // production remains OFF even when the flag is on
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23-19. imports ONLY ./runtime-feature-flag + ./final-go-live-readiness-report and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-integration-coordinator.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./final-go-live-readiness-report', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/integration/server wiring');
});

test('W23-20. coordinator is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
