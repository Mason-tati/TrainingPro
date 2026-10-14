// WP-22 · Phase 4 — Enterprise Document Engine Controlled Server Registration tests.
// Verifies the server-registration-preparation module: exact export surface; enabled derives from
// ./runtime-feature-flag (OFF while DOCUMENT_ENGINE_ENABLED unset); the Phase 3 production mount is
// delegated fresh; createServerRegistration assembles enabled/productionMount/status (prepared:true,
// registered:false, mounted:false); next-phase; copy-on-read; determinism; never throws; imports
// ONLY the allowed pair; performs no process.env/Express/registration; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const S = require(path.join(EDIR, 'server-registration-preparation.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const productionMountPreparation = require(path.join(EDIR, 'production-mount-preparation.js'));

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

test('W4-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'capabilities', 'createServerRegistration', 'getNextPhase', 'getProductionMount', 'getStatus', 'health', 'isServerRegistrationPrepared',
  ]);
});

test('W4-2. every export is a function', () => {
  for (const k of Object.keys(S)) assert.equal(typeof S[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W4-3. isServerRegistrationPrepared derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(S.isServerRegistrationPrepared(), false);
    assert.equal(S.isServerRegistrationPrepared(), runtimeFeatureFlag.isEnabled());
  });
});

test('W4-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    S.createServerRegistration();
    S.getProductionMount();
    S.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(S.isServerRegistrationPrepared(), false);
  });
});

// ---------------------------------------------------------------------------
// getProductionMount
// ---------------------------------------------------------------------------

test('W4-5. getProductionMount delegates to production-mount-preparation.createProductionMount() with the expected shape', () => {
  const pm = S.getProductionMount();
  assert.deepEqual(Object.keys(pm).sort(), ['enabled', 'integrationPlan', 'status']);
  assert.deepEqual(pm.status, { prepared: true, mounted: false, production: false, mode: 'FOUNDATION' });
});

test('W4-6. getProductionMount returns a FRESH mount every call', () => {
  const a = S.getProductionMount();
  const b = S.getProductionMount();
  assert.notEqual(a, b);
  assert.notEqual(a.integrationPlan, b.integrationPlan);
});

test('W4-7. getProductionMount is consistent with production-mount-preparation directly', () => {
  assert.deepEqual(Object.keys(S.getProductionMount()).sort(), Object.keys(productionMountPreparation.createProductionMount()).sort());
});

// ---------------------------------------------------------------------------
// createServerRegistration
// ---------------------------------------------------------------------------

test('W4-8. createServerRegistration returns the expected shape', () => {
  withUnset(() => {
    const sr = S.createServerRegistration();
    assert.deepEqual(Object.keys(sr).sort(), ['enabled', 'productionMount', 'status']);
    assert.equal(sr.enabled, false);
    assert.deepEqual(sr.status, { prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION' });
    assert.deepEqual(Object.keys(sr.productionMount).sort(), ['enabled', 'integrationPlan', 'status']);
  });
});

test('W4-9. createServerRegistration wires the prepared chain (mount → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const sr = S.createServerRegistration();
  const chain = sr.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W4-10. createServerRegistration: prepared true, registered/mounted/production false, and registers nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const sr = S.createServerRegistration();
  assert.equal(sr.status.prepared, true);
  assert.equal(sr.status.registered, false);
  assert.equal(sr.status.mounted, false);
  assert.equal(sr.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing registered/mounted');
});

test('W4-11. createServerRegistration returns a FRESH object with fresh productionMount/status every call', () => {
  const a = S.createServerRegistration();
  const b = S.createServerRegistration();
  assert.notEqual(a, b);
  assert.notEqual(a.productionMount, b.productionMount);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W4-12. getStatus returns the expected status + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(S.getStatus(), {
      enabled: false, prepared: true, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
  });
  const a = S.getStatus();
  const b = S.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(S.getStatus().mode, 'FOUNDATION');
});

test('W4-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(S.health(), { ready: true, enabled: false, registrationAvailable: true });
  });
  const a = S.health();
  const b = S.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(S.health().ready, true);
});

test('W4-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = S.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'server-registration-preparation', 'runtime-feature-flag', 'production-mount-preparation', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = S.capabilities();
  const b = S.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(S.capabilities()[0].available, true);
});

test('W4-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(S.getNextPhase(), {
    phase: 'WP-22 Phase 5', description: 'Controlled Production Registration Validation', productionImpact: false,
  });
  const a = S.getNextPhase();
  const b = S.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(S.getNextPhase().phase, 'WP-22 Phase 5');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W4-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(S.isServerRegistrationPrepared(), S.isServerRegistrationPrepared());
    assert.deepEqual(S.getProductionMount(), S.getProductionMount());
    assert.deepEqual(S.createServerRegistration(), S.createServerRegistration());
    assert.deepEqual(S.getStatus(), S.getStatus());
    assert.deepEqual(S.health(), S.health());
    assert.deepEqual(S.capabilities(), S.capabilities());
    assert.deepEqual(S.getNextPhase(), S.getNextPhase());
  });
});

test('W4-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(S)) noThrow(() => S[k](h, h, h), `S.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', registered: true });
    assert.equal(S.isServerRegistrationPrepared(frozen), false);
    assert.equal(S.getStatus(frozen).registered, false);
    assert.equal(S.createServerRegistration(frozen).status.registered, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', registered: true });
  });
});

test('W4-18. registered/mounted/production stay false even when the runtime flag is enabled (prepared, never registered)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const sr = S.createServerRegistration();
    assert.equal(sr.enabled, true); // derives from runtime flag
    assert.equal(sr.status.prepared, true);
    assert.equal(sr.status.registered, false); // still never registered
    assert.equal(sr.status.mounted, false);
    assert.equal(sr.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + no forbidden APIs + unwired
// ---------------------------------------------------------------------------

test('W4-19. imports ONLY ./runtime-feature-flag + ./production-mount-preparation and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-registration-preparation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-mount-preparation', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'sqlite3', 'fs', 'path', 'dotenv']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/registration/server wiring');
});

test('W4-20. server registration preparation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
