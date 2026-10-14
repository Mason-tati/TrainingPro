// WP-20 · E7 — Enterprise Controlled Production Validation tests.
// Verifies the isolated production-validation module: it exposes exactly the six functions, always
// reports validation not ready (derived from ./production-readiness.isProductionReady()), produces
// the expected fresh validation/status/health/capabilities/next-phase, is deterministic and
// copy-on-read, never throws, imports ONLY ./production-readiness (no Express/server/production
// wiring), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const V = require(path.join(EDIR, 'production-validation.js'));
const productionReadiness = require(path.join(EDIR, 'production-readiness.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E7-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(V).sort(), [
    'capabilities', 'getNextPhase', 'getProductionValidation', 'getStatus', 'health', 'isProductionValidationReady',
  ]);
});

test('E7-2. every export is a function', () => {
  for (const k of Object.keys(V)) assert.equal(typeof V[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isProductionValidationReady — always false, derived from production-readiness
// ---------------------------------------------------------------------------

test('E7-3. isProductionValidationReady always returns false', () => {
  assert.equal(V.isProductionValidationReady(), false);
  assert.equal(V.isProductionValidationReady(), V.isProductionValidationReady());
});

test('E7-4. isProductionValidationReady is derived from production-readiness.isProductionReady()', () => {
  assert.equal(V.isProductionValidationReady(), productionReadiness.isProductionReady());
});

// ---------------------------------------------------------------------------
// getProductionValidation
// ---------------------------------------------------------------------------

test('E7-5. getProductionValidation returns the expected descriptor', () => {
  assert.deepEqual(V.getProductionValidation(), { ready: true, validationReady: false, enabled: false, safe: true });
});

test('E7-6. getProductionValidation.enabled tracks production-readiness', () => {
  assert.equal(V.getProductionValidation().enabled, productionReadiness.isProductionReady());
});

test('E7-7. getProductionValidation returns a FRESH object every call (copy-on-read)', () => {
  const a = V.getProductionValidation();
  const b = V.getProductionValidation();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.validationReady = true;
  a.enabled = true;
  assert.deepEqual(V.getProductionValidation(), { ready: true, validationReady: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E7-8. getStatus returns the expected status', () => {
  assert.deepEqual(V.getStatus(), { enabled: false, validationReady: false, production: false, mode: 'FOUNDATION' });
});

test('E7-9. getStatus.enabled tracks production-readiness', () => {
  assert.equal(V.getStatus().enabled, productionReadiness.isProductionReady());
});

test('E7-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = V.getStatus();
  const b = V.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(V.getStatus(), { enabled: false, validationReady: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E7-11. health returns the expected descriptor', () => {
  assert.deepEqual(V.health(), { ready: true, productionValidationAvailable: true, enabled: false });
});

test('E7-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = V.health();
  const b = V.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(V.health(), { ready: true, productionValidationAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E7-13. capabilities returns the expected four entries', () => {
  const caps = V.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'production-validation', 'production-readiness', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E7-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = V.capabilities();
  const b = V.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = V.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E7-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(V.getNextPhase(), {
    phase: 'WP-20 E8', description: 'Controlled production activation', productionImpact: false,
  });
});

test('E7-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = V.getNextPhase();
  const b = V.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(V.getNextPhase(), {
    phase: 'WP-20 E8', description: 'Controlled production activation', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E7-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(V.isProductionValidationReady(), V.isProductionValidationReady());
  assert.deepEqual(V.getProductionValidation(), V.getProductionValidation());
  assert.deepEqual(V.getStatus(), V.getStatus());
  assert.deepEqual(V.health(), V.health());
  assert.deepEqual(V.capabilities(), V.capabilities());
  assert.deepEqual(V.getNextPhase(), V.getNextPhase());
});

test('E7-18. never throws + frozen input unchanged + validation stays not-ready regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(V)) noThrow(() => V[k](h, h, h), `V.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(V.isProductionValidationReady(frozen), false);
  assert.equal(V.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-production-wiring + unwired
// ---------------------------------------------------------------------------

test('E7-19. production-validation.js imports ONLY ./production-readiness and performs no production wiring', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-validation.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './production-readiness');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'service-registration', 'route-registration', 'mount-registration', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs production wiring: no app/router creation, mounting, or server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no production/server wiring');
});

test('E7-20. production-validation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
