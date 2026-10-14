// WP-23 · Phase 7 — Enterprise Document Engine Controlled Production Runtime Readiness tests.
// Verifies the module: exact export surface; enabled derives from ./runtime-feature-flag (OFF while
// DOCUMENT_ENGINE_ENABLED unset); the WP-23 Phase 6 runtime registration validation is delegated
// fresh; createProductionRuntimeReadiness assembles enabled/runtimeRegistrationValidation/status
// (ready/validated/runtimeReady/adapted/planned/coordinated/prepared/implementationReady/
// registrationReady true, implemented/wired/registered/mounted/production false); next-phase;
// copy-on-read; determinism; never throws; imports ONLY the allowed pair (no Express); performs no
// process.env/Express/registration; route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'production-runtime-readiness.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeRegistrationValidation = require(path.join(EDIR, 'runtime-registration-validation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  ready: true, validated: true, runtimeReady: true, adapted: true, planned: true, coordinated: true, prepared: true,
  implementationReady: true, registrationReady: true,
  implemented: false, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23P7-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(R).sort(), [
    'capabilities', 'createProductionRuntimeReadiness', 'getNextPhase', 'getRuntimeRegistrationValidation', 'getStatus', 'health', 'isProductionRuntimeReady',
  ]);
});

test('W23P7-2. every export is a function', () => {
  for (const k of Object.keys(R)) assert.equal(typeof R[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23P7-3. isProductionRuntimeReady derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(R.isProductionRuntimeReady(), false);
    assert.equal(R.isProductionRuntimeReady(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23P7-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    R.createProductionRuntimeReadiness();
    R.getRuntimeRegistrationValidation();
    R.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(R.isProductionRuntimeReady(), false);
  });
});

// ---------------------------------------------------------------------------
// getRuntimeRegistrationValidation
// ---------------------------------------------------------------------------

test('W23P7-5. getRuntimeRegistrationValidation delegates to runtime-registration-validation.createRuntimeRegistrationValidation()', () => {
  const rv = R.getRuntimeRegistrationValidation();
  assert.deepEqual(Object.keys(rv).sort(), ['enabled', 'runtimeRegistration', 'status']);
  assert.equal(rv.status.validated, true);
  assert.equal(rv.status.registered, false);
});

test('W23P7-6. getRuntimeRegistrationValidation returns a FRESH object every call', () => {
  const a = R.getRuntimeRegistrationValidation();
  const b = R.getRuntimeRegistrationValidation();
  assert.notEqual(a, b);
  assert.notEqual(a.runtimeRegistration, b.runtimeRegistration);
});

test('W23P7-7. getRuntimeRegistrationValidation is consistent with runtime-registration-validation directly', () => {
  assert.deepEqual(Object.keys(R.getRuntimeRegistrationValidation()).sort(), Object.keys(runtimeRegistrationValidation.createRuntimeRegistrationValidation()).sort());
});

// ---------------------------------------------------------------------------
// createProductionRuntimeReadiness
// ---------------------------------------------------------------------------

test('W23P7-8. createProductionRuntimeReadiness returns the expected shape', () => {
  withUnset(() => {
    const pr = R.createProductionRuntimeReadiness();
    assert.deepEqual(Object.keys(pr).sort(), ['enabled', 'runtimeRegistrationValidation', 'status']);
    assert.equal(pr.enabled, false);
    assert.deepEqual(pr.status, STATUS);
    assert.deepEqual(Object.keys(pr.runtimeRegistrationValidation).sort(), ['enabled', 'runtimeRegistration', 'status']);
  });
});

test('W23P7-9. createProductionRuntimeReadiness wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const pr = R.createProductionRuntimeReadiness();
  const chain = pr.runtimeRegistrationValidation.runtimeRegistration.expressRegistrationAdapter.expressMountAdapter.mountImplementationPlan.coordinator.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23P7-10. createProductionRuntimeReadiness: ready/validated/runtimeReady/implementationReady/registrationReady true, implemented/wired/registered/mounted/production false, registers nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const pr = R.createProductionRuntimeReadiness();
  assert.equal(pr.status.ready, true);
  assert.equal(pr.status.validated, true);
  assert.equal(pr.status.runtimeReady, true);
  assert.equal(pr.status.implementationReady, true);
  assert.equal(pr.status.registrationReady, true);
  assert.equal(pr.status.implemented, false);
  assert.equal(pr.status.wired, false);
  assert.equal(pr.status.registered, false);
  assert.equal(pr.status.mounted, false);
  assert.equal(pr.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing registered');
});

test('W23P7-11. createProductionRuntimeReadiness returns a FRESH object with fresh validation/status every call', () => {
  const a = R.createProductionRuntimeReadiness();
  const b = R.createProductionRuntimeReadiness();
  assert.notEqual(a, b);
  assert.notEqual(a.runtimeRegistrationValidation, b.runtimeRegistrationValidation);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23P7-12. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(R.getStatus(), { enabled: false, ...STATUS });
  });
  const a = R.getStatus();
  const b = R.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(R.getStatus().mode, 'FOUNDATION');
});

test('W23P7-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(R.health(), { ready: true, enabled: false, productionRuntimeReadinessAvailable: true });
  });
  const a = R.health();
  const b = R.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(R.health().ready, true);
});

test('W23P7-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = R.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-runtime-readiness', 'runtime-registration-validation', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = R.capabilities();
  const b = R.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(R.capabilities()[0].available, true);
});

test('W23P7-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(R.getNextPhase(), {
    phase: 'WP-23 Phase 8', description: 'Final Runtime Integration Report', productionImpact: false,
  });
  const a = R.getNextPhase();
  const b = R.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(R.getNextPhase().phase, 'WP-23 Phase 8');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23P7-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(R.isProductionRuntimeReady(), R.isProductionRuntimeReady());
    assert.deepEqual(R.getRuntimeRegistrationValidation(), R.getRuntimeRegistrationValidation());
    assert.deepEqual(R.createProductionRuntimeReadiness(), R.createProductionRuntimeReadiness());
    assert.deepEqual(R.getStatus(), R.getStatus());
    assert.deepEqual(R.health(), R.health());
    assert.deepEqual(R.capabilities(), R.capabilities());
    assert.deepEqual(R.getNextPhase(), R.getNextPhase());
  });
});

test('W23P7-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(R)) noThrow(() => R[k](h, h, h), `R.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', registered: true });
    assert.equal(R.isProductionRuntimeReady(frozen), false);
    assert.equal(R.getStatus(frozen).registered, false);
    assert.equal(R.createProductionRuntimeReadiness(frozen).status.registered, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', registered: true });
  });
});

test('W23P7-18. runtime flag enabled still registers nothing (route stack unchanged); implemented/production stay OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const pr = R.createProductionRuntimeReadiness();
    assert.equal(pr.enabled, true); // derives from runtime flag
    assert.equal(pr.status.ready, true);
    assert.equal(pr.status.implemented, false); // still never implemented
    assert.equal(pr.status.registered, false); // still never registered
    assert.equal(pr.status.mounted, false);
    assert.equal(pr.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23P7-19. imports ONLY the allowed pair, does NOT import Express, and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-runtime-readiness.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './runtime-registration-validation']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/registration/server wiring');
});

test('W23P7-20. production runtime readiness is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
