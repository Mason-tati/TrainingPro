// WP-21 · Phase 7 — Enterprise Feature-Gated Production Readiness Confirmation tests.
// Verifies the confirmation module: exact export surface; flag-derived disabled state; the Phase 6
// validation is delegated fresh; createConfirmation assembles enabled/validation/status
// (confirmed:true, integrated:false); next-phase descriptor; copy-on-read; never throws under
// hostile inputs; imports ONLY ./feature-flag + ./production-integration-validation (no express/
// server/fs/path/sqlite3/etc.); and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'production-readiness-confirmation.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const productionIntegrationValidation = require(path.join(EDIR, 'production-integration-validation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P7-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'createConfirmation', 'getNextPhase', 'getStatus', 'getValidation', 'health', 'isReadinessConfirmationEnabled',
  ]);
});

test('P7-2. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P7-3. isReadinessConfirmationEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(C.isReadinessConfirmationEnabled(), false);
  assert.equal(C.isReadinessConfirmationEnabled(), featureFlag.isEnabled());
});

test('P7-4. feature flag remains OFF after exercising the module', () => {
  C.createConfirmation();
  C.getValidation();
  C.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(C.isReadinessConfirmationEnabled(), false);
});

// ---------------------------------------------------------------------------
// getValidation
// ---------------------------------------------------------------------------

test('P7-5. getValidation delegates to production-integration-validation.createValidation() with the expected shape', () => {
  const val = C.getValidation();
  assert.deepEqual(Object.keys(val).sort(), ['enabled', 'integrationPlan', 'status']);
  assert.equal(val.enabled, false);
  assert.deepEqual(val.status, { validated: true, integrated: false, production: false, mode: 'FOUNDATION' });
});

test('P7-6. getValidation returns a FRESH validation every call', () => {
  const a = C.getValidation();
  const b = C.getValidation();
  assert.notEqual(a, b);
  assert.notEqual(a.integrationPlan, b.integrationPlan);
});

test('P7-7. getValidation is consistent with production-integration-validation directly', () => {
  assert.deepEqual(Object.keys(C.getValidation()).sort(), Object.keys(productionIntegrationValidation.createValidation()).sort());
});

// ---------------------------------------------------------------------------
// createConfirmation
// ---------------------------------------------------------------------------

test('P7-8. createConfirmation returns the expected shape', () => {
  const conf = C.createConfirmation();
  assert.deepEqual(Object.keys(conf).sort(), ['enabled', 'status', 'validation']);
  assert.equal(conf.enabled, false);
  assert.deepEqual(conf.status, { confirmed: true, integrated: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(conf.validation).sort(), ['enabled', 'integrationPlan', 'status']);
});

test('P7-9. createConfirmation wires the full prepared chain (validation → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const conf = C.createConfirmation();
  const chain = conf.validation.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
  assert.equal(conf.validation.status.validated, true);
});

test('P7-10. createConfirmation: confirmed true, integrated/production false', () => {
  const conf = C.createConfirmation();
  assert.equal(conf.status.confirmed, true);
  assert.equal(conf.status.integrated, false);
  assert.equal(conf.status.production, false);
});

test('P7-11. createConfirmation returns a FRESH object with fresh validation/status every call', () => {
  const a = C.createConfirmation();
  const b = C.createConfirmation();
  assert.notEqual(a, b);
  assert.notEqual(a.validation, b.validation);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// health / capabilities / status / next phase
// ---------------------------------------------------------------------------

test('P7-12. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(C.health(), { ready: true, enabled: false, confirmationAvailable: true });
  const a = C.health();
  const b = C.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(C.health().ready, true);
});

test('P7-13. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = C.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-validation', 'readiness-confirmation', 'feature-flag-disabled', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = C.capabilities();
  const b = C.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(C.capabilities()[0].available, true);
});

test('P7-14. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(C.getStatus(), { enabled: false, confirmed: true, integrated: false, production: false, mode: 'FOUNDATION' });
  const a = C.getStatus();
  const b = C.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(C.getStatus().mode, 'FOUNDATION');
});

test('P7-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(C.getNextPhase(), {
    phase: 'WP-21 Phase 8', description: 'Final Enterprise Production Integration Report', productionImpact: false,
  });
  const a = C.getNextPhase();
  const b = C.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(C.getNextPhase().phase, 'WP-21 Phase 8');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P7-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(C.isReadinessConfirmationEnabled(), C.isReadinessConfirmationEnabled());
  assert.deepEqual(C.getValidation(), C.getValidation());
  assert.deepEqual(C.createConfirmation(), C.createConfirmation());
  assert.deepEqual(C.health(), C.health());
  assert.deepEqual(C.capabilities(), C.capabilities());
  assert.deepEqual(C.getStatus(), C.getStatus());
  assert.deepEqual(C.getNextPhase(), C.getNextPhase());
});

test('P7-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(C)) noThrow(() => C[k](h, h, h), `C.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON', integrated: true, production: true });
  assert.equal(C.isReadinessConfirmationEnabled(frozen), false);
  assert.equal(C.getStatus(frozen).integrated, false);
  assert.equal(C.createConfirmation(frozen).status.production, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON', integrated: true, production: true });
});

// ---------------------------------------------------------------------------
// import discipline (whitelist + forbidden) + no runtime behaviour + unwired
// ---------------------------------------------------------------------------

test('P7-18. production-readiness-confirmation.js imports ONLY ./feature-flag + ./production-integration-validation', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-readiness-confirmation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-integration-validation', './runtime-feature-flag']);
});

test('P7-19. no forbidden imports and no runtime/Express/DB usage in source', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-readiness-confirmation.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'sqlite3', 'dotenv']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  for (const sib of ['controller', 'routes', 'api-bridge', 'guarded-route-mount', 'server-mount-preparation', 'server-integration-plan', 'production-completion', 'production-activation', 'production-validation', 'production-readiness']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)|process\.env/.test(src), 'no runtime/Express/env usage');
});

test('P7-20. readiness confirmation module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
