// WP-22 · Phase 5 — Enterprise Document Engine Controlled Production Registration Validation tests.
// Verifies the production-registration-validation module: exact export surface; enabled derives
// from ./runtime-feature-flag (OFF while DOCUMENT_ENGINE_ENABLED unset); the Phase 4 server
// registration is delegated fresh; createRegistrationValidation assembles enabled/serverRegistration/
// status (validated:true, prepared:true, registered:false, mounted:false); next-phase; copy-on-read;
// determinism; never throws; imports ONLY the allowed pair; performs no process.env/Express/
// registration; the route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const V = require(path.join(EDIR, 'production-registration-validation.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const serverRegistrationPreparation = require(path.join(EDIR, 'server-registration-preparation.js'));

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

test('W5-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(V).sort(), [
    'capabilities', 'createRegistrationValidation', 'getNextPhase', 'getServerRegistration', 'getStatus', 'health', 'isRegistrationValidated',
  ]);
});

test('W5-2. every export is a function', () => {
  for (const k of Object.keys(V)) assert.equal(typeof V[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W5-3. isRegistrationValidated derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(V.isRegistrationValidated(), false);
    assert.equal(V.isRegistrationValidated(), runtimeFeatureFlag.isEnabled());
  });
});

test('W5-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    V.createRegistrationValidation();
    V.getServerRegistration();
    V.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(V.isRegistrationValidated(), false);
  });
});

// ---------------------------------------------------------------------------
// getServerRegistration
// ---------------------------------------------------------------------------

test('W5-5. getServerRegistration delegates to server-registration-preparation.createServerRegistration()', () => {
  const sr = V.getServerRegistration();
  assert.deepEqual(Object.keys(sr).sort(), ['enabled', 'productionMount', 'status']);
  assert.deepEqual(sr.status, { prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION' });
});

test('W5-6. getServerRegistration returns a FRESH object every call', () => {
  const a = V.getServerRegistration();
  const b = V.getServerRegistration();
  assert.notEqual(a, b);
  assert.notEqual(a.productionMount, b.productionMount);
});

test('W5-7. getServerRegistration is consistent with server-registration-preparation directly', () => {
  assert.deepEqual(Object.keys(V.getServerRegistration()).sort(), Object.keys(serverRegistrationPreparation.createServerRegistration()).sort());
});

// ---------------------------------------------------------------------------
// createRegistrationValidation
// ---------------------------------------------------------------------------

test('W5-8. createRegistrationValidation returns the expected shape', () => {
  withUnset(() => {
    const rv = V.createRegistrationValidation();
    assert.deepEqual(Object.keys(rv).sort(), ['enabled', 'serverRegistration', 'status']);
    assert.equal(rv.enabled, false);
    assert.deepEqual(rv.status, {
      validated: true, prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
    assert.deepEqual(Object.keys(rv.serverRegistration).sort(), ['enabled', 'productionMount', 'status']);
  });
});

test('W5-9. createRegistrationValidation wires the prepared chain end-to-end (registration → mount → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const rv = V.createRegistrationValidation();
  const chain = rv.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W5-10. createRegistrationValidation: validated/prepared true, registered/mounted/production false, registers nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const rv = V.createRegistrationValidation();
  assert.equal(rv.status.validated, true);
  assert.equal(rv.status.prepared, true);
  assert.equal(rv.status.registered, false);
  assert.equal(rv.status.mounted, false);
  assert.equal(rv.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing registered/mounted');
});

test('W5-11. createRegistrationValidation returns a FRESH object with fresh serverRegistration/status every call', () => {
  const a = V.createRegistrationValidation();
  const b = V.createRegistrationValidation();
  assert.notEqual(a, b);
  assert.notEqual(a.serverRegistration, b.serverRegistration);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W5-12. getStatus returns the expected status + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(V.getStatus(), {
      enabled: false, validated: true, prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
  });
  const a = V.getStatus();
  const b = V.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(V.getStatus().mode, 'FOUNDATION');
});

test('W5-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(V.health(), { ready: true, enabled: false, validationAvailable: true });
  });
  const a = V.health();
  const b = V.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(V.health().ready, true);
});

test('W5-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = V.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-registration-validation', 'server-registration-preparation', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = V.capabilities();
  const b = V.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(V.capabilities()[0].available, true);
});

test('W5-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(V.getNextPhase(), {
    phase: 'WP-22 Phase 6', description: 'Controlled Server Wiring Preparation', productionImpact: false,
  });
  const a = V.getNextPhase();
  const b = V.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(V.getNextPhase().phase, 'WP-22 Phase 6');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W5-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(V.isRegistrationValidated(), V.isRegistrationValidated());
    assert.deepEqual(V.getServerRegistration(), V.getServerRegistration());
    assert.deepEqual(V.createRegistrationValidation(), V.createRegistrationValidation());
    assert.deepEqual(V.getStatus(), V.getStatus());
    assert.deepEqual(V.health(), V.health());
    assert.deepEqual(V.capabilities(), V.capabilities());
    assert.deepEqual(V.getNextPhase(), V.getNextPhase());
  });
});

test('W5-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(V)) noThrow(() => V[k](h, h, h), `V.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', registered: true });
    assert.equal(V.isRegistrationValidated(frozen), false);
    assert.equal(V.getStatus(frozen).registered, false);
    assert.equal(V.createRegistrationValidation(frozen).status.registered, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', registered: true });
  });
});

test('W5-18. runtime flag enabled still never registers/mounts anything (route stack unchanged)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const rv = V.createRegistrationValidation();
    assert.equal(rv.enabled, true); // derives from runtime flag
    assert.equal(rv.status.validated, true);
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

test('W5-19. imports ONLY ./runtime-feature-flag + ./server-registration-preparation and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-registration-validation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-registration-preparation']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/registration/server wiring');
});

test('W5-20. production registration validation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
