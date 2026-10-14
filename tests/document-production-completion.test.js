// WP-20 · E9 — Enterprise Controlled Production Completion tests.
// Verifies the isolated production-completion module: it exposes exactly the six functions, always
// reports completion not ready (derived from ./production-activation.isProductionActivationReady()),
// produces the expected fresh completion/status/health/capabilities/next-phase, is deterministic
// and copy-on-read, never throws, imports ONLY ./production-activation (no Express/server/production
// wiring), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'production-completion.js'));
const productionActivation = require(path.join(EDIR, 'production-activation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E9-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'getNextPhase', 'getProductionCompletion', 'getStatus', 'health', 'isProductionCompletionReady',
  ]);
});

test('E9-2. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isProductionCompletionReady — always false, derived from production-activation
// ---------------------------------------------------------------------------

test('E9-3. isProductionCompletionReady always returns false', () => {
  assert.equal(C.isProductionCompletionReady(), false);
  assert.equal(C.isProductionCompletionReady(), C.isProductionCompletionReady());
});

test('E9-4. isProductionCompletionReady is derived from production-activation.isProductionActivationReady()', () => {
  assert.equal(C.isProductionCompletionReady(), productionActivation.isProductionActivationReady());
});

// ---------------------------------------------------------------------------
// getProductionCompletion
// ---------------------------------------------------------------------------

test('E9-5. getProductionCompletion returns the expected descriptor', () => {
  assert.deepEqual(C.getProductionCompletion(), { ready: true, completionReady: false, enabled: false, safe: true });
});

test('E9-6. getProductionCompletion.enabled tracks production-activation', () => {
  assert.equal(C.getProductionCompletion().enabled, productionActivation.isProductionActivationReady());
});

test('E9-7. getProductionCompletion returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getProductionCompletion();
  const b = C.getProductionCompletion();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.completionReady = true;
  a.enabled = true;
  assert.deepEqual(C.getProductionCompletion(), { ready: true, completionReady: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E9-8. getStatus returns the expected status', () => {
  assert.deepEqual(C.getStatus(), { enabled: false, completionReady: false, production: false, mode: 'FOUNDATION' });
});

test('E9-9. getStatus.enabled tracks production-activation', () => {
  assert.equal(C.getStatus().enabled, productionActivation.isProductionActivationReady());
});

test('E9-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getStatus();
  const b = C.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(C.getStatus(), { enabled: false, completionReady: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E9-11. health returns the expected descriptor', () => {
  assert.deepEqual(C.health(), { ready: true, productionCompletionAvailable: true, enabled: false });
});

test('E9-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = C.health();
  const b = C.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(C.health(), { ready: true, productionCompletionAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E9-13. capabilities returns the expected four entries', () => {
  const caps = C.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'production-completion', 'production-activation', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E9-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = C.capabilities();
  const b = C.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = C.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E9-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(C.getNextPhase(), {
    phase: 'WP-20 E10', description: 'Final production integration report', productionImpact: false,
  });
});

test('E9-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getNextPhase();
  const b = C.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(C.getNextPhase(), {
    phase: 'WP-20 E10', description: 'Final production integration report', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E9-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(C.isProductionCompletionReady(), C.isProductionCompletionReady());
  assert.deepEqual(C.getProductionCompletion(), C.getProductionCompletion());
  assert.deepEqual(C.getStatus(), C.getStatus());
  assert.deepEqual(C.health(), C.health());
  assert.deepEqual(C.capabilities(), C.capabilities());
  assert.deepEqual(C.getNextPhase(), C.getNextPhase());
});

test('E9-18. never throws + frozen input unchanged + completion stays not-ready regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(C)) noThrow(() => C[k](h, h, h), `C.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(C.isProductionCompletionReady(frozen), false);
  assert.equal(C.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-production-wiring + unwired
// ---------------------------------------------------------------------------

test('E9-19. production-completion.js imports ONLY ./production-activation and performs no production wiring', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-completion.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './production-activation');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'service-registration', 'route-registration', 'mount-registration', 'production-readiness', 'production-validation', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs production wiring: no app/router creation, mounting, or server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no production/server wiring');
});

test('E9-20. production-completion is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
