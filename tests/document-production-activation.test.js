// WP-20 · E8 — Enterprise Controlled Production Activation tests.
// Verifies the isolated production-activation module: it exposes exactly the six functions, always
// reports activation not ready (derived from ./production-validation.isProductionValidationReady()),
// produces the expected fresh activation/status/health/capabilities/next-phase, is deterministic
// and copy-on-read, never throws, imports ONLY ./production-validation (no Express/server/production
// wiring), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'production-activation.js'));
const productionValidation = require(path.join(EDIR, 'production-validation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E8-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'capabilities', 'getNextPhase', 'getProductionActivation', 'getStatus', 'health', 'isProductionActivationReady',
  ]);
});

test('E8-2. every export is a function', () => {
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isProductionActivationReady — always false, derived from production-validation
// ---------------------------------------------------------------------------

test('E8-3. isProductionActivationReady always returns false', () => {
  assert.equal(A.isProductionActivationReady(), false);
  assert.equal(A.isProductionActivationReady(), A.isProductionActivationReady());
});

test('E8-4. isProductionActivationReady is derived from production-validation.isProductionValidationReady()', () => {
  assert.equal(A.isProductionActivationReady(), productionValidation.isProductionValidationReady());
});

// ---------------------------------------------------------------------------
// getProductionActivation
// ---------------------------------------------------------------------------

test('E8-5. getProductionActivation returns the expected descriptor', () => {
  assert.deepEqual(A.getProductionActivation(), { ready: true, activationReady: false, enabled: false, safe: true });
});

test('E8-6. getProductionActivation.enabled tracks production-validation', () => {
  assert.equal(A.getProductionActivation().enabled, productionValidation.isProductionValidationReady());
});

test('E8-7. getProductionActivation returns a FRESH object every call (copy-on-read)', () => {
  const a = A.getProductionActivation();
  const b = A.getProductionActivation();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.activationReady = true;
  a.enabled = true;
  assert.deepEqual(A.getProductionActivation(), { ready: true, activationReady: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E8-8. getStatus returns the expected status', () => {
  assert.deepEqual(A.getStatus(), { enabled: false, activationReady: false, production: false, mode: 'FOUNDATION' });
});

test('E8-9. getStatus.enabled tracks production-validation', () => {
  assert.equal(A.getStatus().enabled, productionValidation.isProductionValidationReady());
});

test('E8-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = A.getStatus();
  const b = A.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(A.getStatus(), { enabled: false, activationReady: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E8-11. health returns the expected descriptor', () => {
  assert.deepEqual(A.health(), { ready: true, productionActivationAvailable: true, enabled: false });
});

test('E8-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = A.health();
  const b = A.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(A.health(), { ready: true, productionActivationAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E8-13. capabilities returns the expected four entries', () => {
  const caps = A.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'production-activation', 'production-validation', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E8-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = A.capabilities();
  const b = A.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = A.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E8-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-20 E9', description: 'Controlled production completion', productionImpact: false,
  });
});

test('E8-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = A.getNextPhase();
  const b = A.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-20 E9', description: 'Controlled production completion', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E8-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(A.isProductionActivationReady(), A.isProductionActivationReady());
  assert.deepEqual(A.getProductionActivation(), A.getProductionActivation());
  assert.deepEqual(A.getStatus(), A.getStatus());
  assert.deepEqual(A.health(), A.health());
  assert.deepEqual(A.capabilities(), A.capabilities());
  assert.deepEqual(A.getNextPhase(), A.getNextPhase());
});

test('E8-18. never throws + frozen input unchanged + activation stays not-ready regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(A)) noThrow(() => A[k](h, h, h), `A.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(A.isProductionActivationReady(frozen), false);
  assert.equal(A.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-production-wiring + unwired
// ---------------------------------------------------------------------------

test('E8-19. production-activation.js imports ONLY ./production-validation and performs no production wiring', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-activation.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './production-validation');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'service-registration', 'route-registration', 'mount-registration', 'production-readiness', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs production wiring: no app/router creation, mounting, or server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no production/server wiring');
});

test('E8-20. production-activation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
