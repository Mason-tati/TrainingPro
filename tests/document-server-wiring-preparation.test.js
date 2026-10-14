// WP-22 · Phase 6 — Enterprise Document Engine Controlled Server Wiring Preparation tests.
// Verifies the server-wiring-preparation module: exact export surface; enabled derives from
// ./runtime-feature-flag (OFF while DOCUMENT_ENGINE_ENABLED unset); the Phase 5 registration
// validation is delegated fresh; createServerWiring assembles enabled/registrationValidation/status
// (prepared:true, validated:true, wired:false, registered:false, mounted:false); next-phase;
// copy-on-read; determinism; never throws; imports ONLY the allowed pair; performs no process.env/
// Express/wiring; the route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const W = require(path.join(EDIR, 'server-wiring-preparation.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const productionRegistrationValidation = require(path.join(EDIR, 'production-registration-validation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// Run `fn` with DOCUMENT_ENGINE_ENABLED unset (restore afterwards).
function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W6-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(W).sort(), [
    'capabilities', 'createServerWiring', 'getNextPhase', 'getRegistrationValidation', 'getStatus', 'health', 'isServerWiringPrepared',
  ]);
});

test('W6-2. every export is a function', () => {
  for (const k of Object.keys(W)) assert.equal(typeof W[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W6-3. isServerWiringPrepared derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(W.isServerWiringPrepared(), false);
    assert.equal(W.isServerWiringPrepared(), runtimeFeatureFlag.isEnabled());
  });
});

test('W6-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    W.createServerWiring();
    W.getRegistrationValidation();
    W.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(W.isServerWiringPrepared(), false);
  });
});

// ---------------------------------------------------------------------------
// getRegistrationValidation
// ---------------------------------------------------------------------------

test('W6-5. getRegistrationValidation delegates to production-registration-validation.createRegistrationValidation()', () => {
  const rv = W.getRegistrationValidation();
  assert.deepEqual(Object.keys(rv).sort(), ['enabled', 'serverRegistration', 'status']);
  assert.deepEqual(rv.status, {
    validated: true, prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
  });
});

test('W6-6. getRegistrationValidation returns a FRESH object every call', () => {
  const a = W.getRegistrationValidation();
  const b = W.getRegistrationValidation();
  assert.notEqual(a, b);
  assert.notEqual(a.serverRegistration, b.serverRegistration);
});

test('W6-7. getRegistrationValidation is consistent with production-registration-validation directly', () => {
  assert.deepEqual(Object.keys(W.getRegistrationValidation()).sort(), Object.keys(productionRegistrationValidation.createRegistrationValidation()).sort());
});

// ---------------------------------------------------------------------------
// createServerWiring
// ---------------------------------------------------------------------------

test('W6-8. createServerWiring returns the expected shape', () => {
  withUnset(() => {
    const sw = W.createServerWiring();
    assert.deepEqual(Object.keys(sw).sort(), ['enabled', 'registrationValidation', 'status']);
    assert.equal(sw.enabled, false);
    assert.deepEqual(sw.status, {
      prepared: true, validated: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
    assert.deepEqual(Object.keys(sw.registrationValidation).sort(), ['enabled', 'serverRegistration', 'status']);
  });
});

test('W6-9. createServerWiring wires the prepared chain end-to-end (validation → registration → mount → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const sw = W.createServerWiring();
  const chain = sw.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W6-10. createServerWiring: prepared/validated true, wired/registered/mounted/production false, wires nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const sw = W.createServerWiring();
  assert.equal(sw.status.prepared, true);
  assert.equal(sw.status.validated, true);
  assert.equal(sw.status.wired, false);
  assert.equal(sw.status.registered, false);
  assert.equal(sw.status.mounted, false);
  assert.equal(sw.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing wired');
});

test('W6-11. createServerWiring returns a FRESH object with fresh registrationValidation/status every call', () => {
  const a = W.createServerWiring();
  const b = W.createServerWiring();
  assert.notEqual(a, b);
  assert.notEqual(a.registrationValidation, b.registrationValidation);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W6-12. getStatus returns the expected status + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(W.getStatus(), {
      enabled: false, prepared: true, validated: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
  });
  const a = W.getStatus();
  const b = W.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(W.getStatus().mode, 'FOUNDATION');
});

test('W6-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(W.health(), { ready: true, enabled: false, wiringAvailable: true });
  });
  const a = W.health();
  const b = W.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(W.health().ready, true);
});

test('W6-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = W.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'server-wiring-preparation', 'production-registration-validation', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = W.capabilities();
  const b = W.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(W.capabilities()[0].available, true);
});

test('W6-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(W.getNextPhase(), {
    phase: 'WP-22 Phase 7', description: 'Controlled Production Readiness Confirmation', productionImpact: false,
  });
  const a = W.getNextPhase();
  const b = W.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(W.getNextPhase().phase, 'WP-22 Phase 7');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W6-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(W.isServerWiringPrepared(), W.isServerWiringPrepared());
    assert.deepEqual(W.getRegistrationValidation(), W.getRegistrationValidation());
    assert.deepEqual(W.createServerWiring(), W.createServerWiring());
    assert.deepEqual(W.getStatus(), W.getStatus());
    assert.deepEqual(W.health(), W.health());
    assert.deepEqual(W.capabilities(), W.capabilities());
    assert.deepEqual(W.getNextPhase(), W.getNextPhase());
  });
});

test('W6-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(W)) noThrow(() => W[k](h, h, h), `W.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', wired: true });
    assert.equal(W.isServerWiringPrepared(frozen), false);
    assert.equal(W.getStatus(frozen).wired, false);
    assert.equal(W.createServerWiring(frozen).status.wired, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', wired: true });
  });
});

test('W6-18. runtime flag enabled still never wires anything (route stack unchanged)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const sw = W.createServerWiring();
    assert.equal(sw.enabled, true); // derives from runtime flag
    assert.equal(sw.status.prepared, true);
    assert.equal(sw.status.wired, false); // still never wired
    assert.equal(sw.status.registered, false);
    assert.equal(sw.status.mounted, false);
    assert.equal(sw.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W6-19. imports ONLY ./runtime-feature-flag + ./production-registration-validation and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-wiring-preparation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-registration-validation', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/wiring/server wiring');
});

test('W6-20. server wiring preparation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
