// WP-23 · Phase 5 — Enterprise Document Engine Controlled Runtime Registration tests.
// Verifies the controller: exact export surface; enabled derives from ./runtime-feature-flag (OFF
// while DOCUMENT_ENGINE_ENABLED unset); the WP-23 Phase 4 registration adapter is delegated fresh;
// createRuntimeRegistration assembles enabled/expressRegistrationAdapter/status (runtimeReady/adapted/
// planned/coordinated/prepared/validated/implementationReady/registrationReady true, implemented/
// wired/registered/mounted/production false); next-phase; copy-on-read; determinism; never throws;
// imports ONLY the allowed pair (no Express); performs no process.env/Express/registration; route
// stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'runtime-registration-controller.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const expressRegistrationAdapter = require(path.join(EDIR, 'express-registration-adapter.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  runtimeReady: true, adapted: true, planned: true, coordinated: true, prepared: true, validated: true,
  implementationReady: true, registrationReady: true,
  implemented: false, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23P5-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'createRuntimeRegistration', 'getExpressRegistrationAdapter', 'getNextPhase', 'getStatus', 'health', 'isRuntimeRegistrationEnabled',
  ]);
});

test('W23P5-2. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23P5-3. isRuntimeRegistrationEnabled derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(C.isRuntimeRegistrationEnabled(), false);
    assert.equal(C.isRuntimeRegistrationEnabled(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23P5-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    C.createRuntimeRegistration();
    C.getExpressRegistrationAdapter();
    C.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(C.isRuntimeRegistrationEnabled(), false);
  });
});

// ---------------------------------------------------------------------------
// getExpressRegistrationAdapter
// ---------------------------------------------------------------------------

test('W23P5-5. getExpressRegistrationAdapter delegates to express-registration-adapter.createExpressRegistrationAdapter()', () => {
  const ra = C.getExpressRegistrationAdapter();
  assert.deepEqual(Object.keys(ra).sort(), ['enabled', 'expressMountAdapter', 'status']);
  assert.equal(ra.status.registrationReady, true);
  assert.equal(ra.status.registered, false);
});

test('W23P5-6. getExpressRegistrationAdapter returns a FRESH object every call', () => {
  const a = C.getExpressRegistrationAdapter();
  const b = C.getExpressRegistrationAdapter();
  assert.notEqual(a, b);
  assert.notEqual(a.expressMountAdapter, b.expressMountAdapter);
});

test('W23P5-7. getExpressRegistrationAdapter is consistent with express-registration-adapter directly', () => {
  assert.deepEqual(Object.keys(C.getExpressRegistrationAdapter()).sort(), Object.keys(expressRegistrationAdapter.createExpressRegistrationAdapter()).sort());
});

// ---------------------------------------------------------------------------
// createRuntimeRegistration
// ---------------------------------------------------------------------------

test('W23P5-8. createRuntimeRegistration returns the expected shape', () => {
  withUnset(() => {
    const rr = C.createRuntimeRegistration();
    assert.deepEqual(Object.keys(rr).sort(), ['enabled', 'expressRegistrationAdapter', 'status']);
    assert.equal(rr.enabled, false);
    assert.deepEqual(rr.status, STATUS);
    assert.deepEqual(Object.keys(rr.expressRegistrationAdapter).sort(), ['enabled', 'expressMountAdapter', 'status']);
  });
});

test('W23P5-9. createRuntimeRegistration wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const rr = C.createRuntimeRegistration();
  const chain = rr.expressRegistrationAdapter.expressMountAdapter.mountImplementationPlan.coordinator.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23P5-10. createRuntimeRegistration: runtimeReady/implementationReady/registrationReady true, implemented/wired/registered/mounted/production false, registers nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const rr = C.createRuntimeRegistration();
  assert.equal(rr.status.runtimeReady, true);
  assert.equal(rr.status.implementationReady, true);
  assert.equal(rr.status.registrationReady, true);
  assert.equal(rr.status.implemented, false);
  assert.equal(rr.status.wired, false);
  assert.equal(rr.status.registered, false);
  assert.equal(rr.status.mounted, false);
  assert.equal(rr.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing registered');
});

test('W23P5-11. createRuntimeRegistration returns a FRESH object with fresh adapter/status every call', () => {
  const a = C.createRuntimeRegistration();
  const b = C.createRuntimeRegistration();
  assert.notEqual(a, b);
  assert.notEqual(a.expressRegistrationAdapter, b.expressRegistrationAdapter);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23P5-12. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(C.getStatus(), { enabled: false, ...STATUS });
  });
  const a = C.getStatus();
  const b = C.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(C.getStatus().mode, 'FOUNDATION');
});

test('W23P5-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(C.health(), { ready: true, enabled: false, runtimeRegistrationAvailable: true });
  });
  const a = C.health();
  const b = C.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(C.health().ready, true);
});

test('W23P5-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = C.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'runtime-registration-controller', 'express-registration-adapter', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = C.capabilities();
  const b = C.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(C.capabilities()[0].available, true);
});

test('W23P5-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(C.getNextPhase(), {
    phase: 'WP-23 Phase 6', description: 'Controlled Runtime Registration Validation', productionImpact: false,
  });
  const a = C.getNextPhase();
  const b = C.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(C.getNextPhase().phase, 'WP-23 Phase 6');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23P5-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(C.isRuntimeRegistrationEnabled(), C.isRuntimeRegistrationEnabled());
    assert.deepEqual(C.getExpressRegistrationAdapter(), C.getExpressRegistrationAdapter());
    assert.deepEqual(C.createRuntimeRegistration(), C.createRuntimeRegistration());
    assert.deepEqual(C.getStatus(), C.getStatus());
    assert.deepEqual(C.health(), C.health());
    assert.deepEqual(C.capabilities(), C.capabilities());
    assert.deepEqual(C.getNextPhase(), C.getNextPhase());
  });
});

test('W23P5-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(C)) noThrow(() => C[k](h, h, h), `C.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', registered: true });
    assert.equal(C.isRuntimeRegistrationEnabled(frozen), false);
    assert.equal(C.getStatus(frozen).registered, false);
    assert.equal(C.createRuntimeRegistration(frozen).status.registered, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', registered: true });
  });
});

test('W23P5-18. runtime flag enabled still registers nothing (route stack unchanged); implemented/production stay OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const rr = C.createRuntimeRegistration();
    assert.equal(rr.enabled, true); // derives from runtime flag
    assert.equal(rr.status.runtimeReady, true);
    assert.equal(rr.status.implemented, false); // still never implemented
    assert.equal(rr.status.registered, false); // still never registered
    assert.equal(rr.status.mounted, false);
    assert.equal(rr.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23P5-19. imports ONLY the allowed pair, does NOT import Express, and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-registration-controller.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./express-registration-adapter', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/registration/server wiring');
});

test('W23P5-20. runtime registration controller is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
