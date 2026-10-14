// WP-21 · Phase 6 — Enterprise Feature-Gated Production Integration Validation tests.
// Verifies the validation module: exact export surface; flag-derived disabled state; the Phase 5
// integration plan is delegated fresh; createValidation assembles enabled/integrationPlan/status
// (validated:true, integrated:false); next-phase descriptor; copy-on-read; never throws under
// hostile inputs; imports ONLY ./feature-flag + ./server-integration-plan (no express/server/fs/
// path/sqlite3/etc.); and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const V = require(path.join(EDIR, 'production-integration-validation.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const serverIntegrationPlan = require(path.join(EDIR, 'server-integration-plan.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P6-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(V).sort(), [
    'capabilities', 'createValidation', 'getIntegrationPlan', 'getNextPhase', 'getStatus', 'health', 'isValidationEnabled',
  ]);
});

test('P6-2. every export is a function', () => {
  for (const k of Object.keys(V)) assert.equal(typeof V[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P6-3. isValidationEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(V.isValidationEnabled(), false);
  assert.equal(V.isValidationEnabled(), featureFlag.isEnabled());
});

test('P6-4. feature flag remains OFF after exercising the module', () => {
  V.createValidation();
  V.getIntegrationPlan();
  V.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(V.isValidationEnabled(), false);
});

// ---------------------------------------------------------------------------
// getIntegrationPlan
// ---------------------------------------------------------------------------

test('P6-5. getIntegrationPlan delegates to server-integration-plan.createIntegrationPlan() with the expected shape', () => {
  const plan = V.getIntegrationPlan();
  assert.deepEqual(Object.keys(plan).sort(), ['enabled', 'serverMount', 'status']);
  assert.equal(plan.enabled, false);
  assert.deepEqual(plan.status, { planned: true, integrated: false, production: false, mode: 'FOUNDATION' });
});

test('P6-6. getIntegrationPlan returns a FRESH plan every call', () => {
  const a = V.getIntegrationPlan();
  const b = V.getIntegrationPlan();
  assert.notEqual(a, b);
  assert.notEqual(a.serverMount, b.serverMount);
});

test('P6-7. getIntegrationPlan is consistent with server-integration-plan directly', () => {
  assert.deepEqual(Object.keys(V.getIntegrationPlan()).sort(), Object.keys(serverIntegrationPlan.createIntegrationPlan()).sort());
});

// ---------------------------------------------------------------------------
// createValidation
// ---------------------------------------------------------------------------

test('P6-8. createValidation returns the expected shape', () => {
  const val = V.createValidation();
  assert.deepEqual(Object.keys(val).sort(), ['enabled', 'integrationPlan', 'status']);
  assert.equal(val.enabled, false);
  assert.deepEqual(val.status, { validated: true, integrated: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(val.integrationPlan).sort(), ['enabled', 'serverMount', 'status']);
});

test('P6-9. createValidation wires the full prepared chain (plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const val = V.createValidation();
  const chain = val.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
  assert.equal(val.integrationPlan.enabled, false);
});

test('P6-10. createValidation: validated true, integrated/production false', () => {
  const val = V.createValidation();
  assert.equal(val.status.validated, true);
  assert.equal(val.status.integrated, false);
  assert.equal(val.status.production, false);
});

test('P6-11. createValidation returns a FRESH object with fresh integrationPlan/status every call', () => {
  const a = V.createValidation();
  const b = V.createValidation();
  assert.notEqual(a, b);
  assert.notEqual(a.integrationPlan, b.integrationPlan);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// health / capabilities / status / next phase
// ---------------------------------------------------------------------------

test('P6-12. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(V.health(), { ready: true, enabled: false, validationAvailable: true });
  const a = V.health();
  const b = V.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(V.health().ready, true);
});

test('P6-13. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = V.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'integration-plan', 'production-validation', 'feature-flag-disabled', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = V.capabilities();
  const b = V.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(V.capabilities()[0].available, true);
});

test('P6-14. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(V.getStatus(), { enabled: false, validated: true, integrated: false, production: false, mode: 'FOUNDATION' });
  const a = V.getStatus();
  const b = V.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(V.getStatus().mode, 'FOUNDATION');
});

test('P6-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(V.getNextPhase(), {
    phase: 'WP-21 Phase 7', description: 'Feature-gated production readiness confirmation', productionImpact: false,
  });
  const a = V.getNextPhase();
  const b = V.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(V.getNextPhase().phase, 'WP-21 Phase 7');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P6-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(V.isValidationEnabled(), V.isValidationEnabled());
  assert.deepEqual(V.getIntegrationPlan(), V.getIntegrationPlan());
  assert.deepEqual(V.createValidation(), V.createValidation());
  assert.deepEqual(V.health(), V.health());
  assert.deepEqual(V.capabilities(), V.capabilities());
  assert.deepEqual(V.getStatus(), V.getStatus());
  assert.deepEqual(V.getNextPhase(), V.getNextPhase());
});

test('P6-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(V)) noThrow(() => V[k](h, h, h), `V.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON', integrated: true, production: true });
  assert.equal(V.isValidationEnabled(frozen), false);
  assert.equal(V.getStatus(frozen).integrated, false);
  assert.equal(V.createValidation(frozen).status.production, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON', integrated: true, production: true });
});

// ---------------------------------------------------------------------------
// import discipline (whitelist + forbidden) + no runtime behaviour + unwired
// ---------------------------------------------------------------------------

test('P6-18. production-integration-validation.js imports ONLY ./feature-flag + ./server-integration-plan', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-integration-validation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-integration-plan']);
});

test('P6-19. no forbidden imports and no runtime/Express/DB usage in source', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-integration-validation.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'sqlite3', 'dotenv']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  // no require of app-root server/app, or database, or the forbidden sibling modules
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  for (const sib of ['controller', 'routes', 'api-bridge', 'guarded-route-mount', 'server-mount-preparation', 'production-completion', 'production-activation', 'production-validation', 'production-readiness']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // no runtime wiring
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)|process\.env/.test(src), 'no runtime/Express/env usage');
});

test('P6-20. validation module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
