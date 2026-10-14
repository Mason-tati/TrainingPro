// WP-23 · Phase 6 — Enterprise Document Engine Controlled Runtime Registration Validation tests.
// Verifies the validation: exact export surface; enabled derives from ./runtime-feature-flag (OFF
// while DOCUMENT_ENGINE_ENABLED unset); the WP-23 Phase 5 runtime registration is delegated fresh;
// createRuntimeRegistrationValidation assembles enabled/runtimeRegistration/status (validated/
// runtimeReady/adapted/planned/coordinated/prepared/implementationReady/registrationReady true,
// implemented/wired/registered/mounted/production false); next-phase; copy-on-read; determinism;
// never throws; imports ONLY the allowed pair (no Express); performs no process.env/Express/
// registration; route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const V = require(path.join(EDIR, 'runtime-registration-validation.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const runtimeRegistrationController = require(path.join(EDIR, 'runtime-registration-controller.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  validated: true, runtimeReady: true, adapted: true, planned: true, coordinated: true, prepared: true,
  implementationReady: true, registrationReady: true,
  implemented: false, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23P6-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(V).sort(), [
    'capabilities', 'createRuntimeRegistrationValidation', 'getNextPhase', 'getRuntimeRegistration', 'getStatus', 'health', 'isRuntimeRegistrationValidated',
  ]);
});

test('W23P6-2. every export is a function', () => {
  for (const k of Object.keys(V)) assert.equal(typeof V[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23P6-3. isRuntimeRegistrationValidated derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(V.isRuntimeRegistrationValidated(), false);
    assert.equal(V.isRuntimeRegistrationValidated(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23P6-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    V.createRuntimeRegistrationValidation();
    V.getRuntimeRegistration();
    V.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(V.isRuntimeRegistrationValidated(), false);
  });
});

// ---------------------------------------------------------------------------
// getRuntimeRegistration
// ---------------------------------------------------------------------------

test('W23P6-5. getRuntimeRegistration delegates to runtime-registration-controller.createRuntimeRegistration()', () => {
  const rr = V.getRuntimeRegistration();
  assert.deepEqual(Object.keys(rr).sort(), ['enabled', 'expressRegistrationAdapter', 'status']);
  assert.equal(rr.status.runtimeReady, true);
  assert.equal(rr.status.registered, false);
});

test('W23P6-6. getRuntimeRegistration returns a FRESH object every call', () => {
  const a = V.getRuntimeRegistration();
  const b = V.getRuntimeRegistration();
  assert.notEqual(a, b);
  assert.notEqual(a.expressRegistrationAdapter, b.expressRegistrationAdapter);
});

test('W23P6-7. getRuntimeRegistration is consistent with runtime-registration-controller directly', () => {
  assert.deepEqual(Object.keys(V.getRuntimeRegistration()).sort(), Object.keys(runtimeRegistrationController.createRuntimeRegistration()).sort());
});

// ---------------------------------------------------------------------------
// createRuntimeRegistrationValidation
// ---------------------------------------------------------------------------

test('W23P6-8. createRuntimeRegistrationValidation returns the expected shape', () => {
  withUnset(() => {
    const rv = V.createRuntimeRegistrationValidation();
    assert.deepEqual(Object.keys(rv).sort(), ['enabled', 'runtimeRegistration', 'status']);
    assert.equal(rv.enabled, false);
    assert.deepEqual(rv.status, STATUS);
    assert.deepEqual(Object.keys(rv.runtimeRegistration).sort(), ['enabled', 'expressRegistrationAdapter', 'status']);
  });
});

test('W23P6-9. createRuntimeRegistrationValidation wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const rv = V.createRuntimeRegistrationValidation();
  const chain = rv.runtimeRegistration.expressRegistrationAdapter.expressMountAdapter.mountImplementationPlan.coordinator.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23P6-10. createRuntimeRegistrationValidation: validated/runtimeReady/implementationReady/registrationReady true, implemented/wired/registered/mounted/production false, registers nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const rv = V.createRuntimeRegistrationValidation();
  assert.equal(rv.status.validated, true);
  assert.equal(rv.status.runtimeReady, true);
  assert.equal(rv.status.implementationReady, true);
  assert.equal(rv.status.registrationReady, true);
  assert.equal(rv.status.implemented, false);
  assert.equal(rv.status.wired, false);
  assert.equal(rv.status.registered, false);
  assert.equal(rv.status.mounted, false);
  assert.equal(rv.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing registered');
});

test('W23P6-11. createRuntimeRegistrationValidation returns a FRESH object with fresh registration/status every call', () => {
  const a = V.createRuntimeRegistrationValidation();
  const b = V.createRuntimeRegistrationValidation();
  assert.notEqual(a, b);
  assert.notEqual(a.runtimeRegistration, b.runtimeRegistration);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23P6-12. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(V.getStatus(), { enabled: false, ...STATUS });
  });
  const a = V.getStatus();
  const b = V.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(V.getStatus().mode, 'FOUNDATION');
});

test('W23P6-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(V.health(), { ready: true, enabled: false, runtimeRegistrationValidationAvailable: true });
  });
  const a = V.health();
  const b = V.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(V.health().ready, true);
});

test('W23P6-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = V.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'runtime-registration-validation', 'runtime-registration-controller', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = V.capabilities();
  const b = V.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(V.capabilities()[0].available, true);
});

test('W23P6-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(V.getNextPhase(), {
    phase: 'WP-23 Phase 7', description: 'Controlled Production Runtime Readiness', productionImpact: false,
  });
  const a = V.getNextPhase();
  const b = V.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(V.getNextPhase().phase, 'WP-23 Phase 7');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23P6-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(V.isRuntimeRegistrationValidated(), V.isRuntimeRegistrationValidated());
    assert.deepEqual(V.getRuntimeRegistration(), V.getRuntimeRegistration());
    assert.deepEqual(V.createRuntimeRegistrationValidation(), V.createRuntimeRegistrationValidation());
    assert.deepEqual(V.getStatus(), V.getStatus());
    assert.deepEqual(V.health(), V.health());
    assert.deepEqual(V.capabilities(), V.capabilities());
    assert.deepEqual(V.getNextPhase(), V.getNextPhase());
  });
});

test('W23P6-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(V)) noThrow(() => V[k](h, h, h), `V.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', registered: true });
    assert.equal(V.isRuntimeRegistrationValidated(frozen), false);
    assert.equal(V.getStatus(frozen).registered, false);
    assert.equal(V.createRuntimeRegistrationValidation(frozen).status.registered, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', registered: true });
  });
});

test('W23P6-18. runtime flag enabled still registers nothing (route stack unchanged); implemented/production stay OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const rv = V.createRuntimeRegistrationValidation();
    assert.equal(rv.enabled, true); // derives from runtime flag
    assert.equal(rv.status.validated, true);
    assert.equal(rv.status.implemented, false); // still never implemented
    assert.equal(rv.status.registered, false); // still never registered
    assert.equal(rv.status.mounted, false);
    assert.equal(rv.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23P6-19. imports ONLY the allowed pair, does NOT import Express, and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-registration-validation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './runtime-registration-controller']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/registration/server wiring');
});

test('W23P6-20. runtime registration validation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
