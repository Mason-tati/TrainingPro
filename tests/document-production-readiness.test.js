// WP-20 · E6 — Enterprise Controlled Production Readiness tests.
// Verifies the isolated production-readiness module: it exposes exactly the six functions, always
// reports production not ready (derived from ./mount-registration.isMountRegistrationEnabled()),
// produces the expected fresh readiness/status/health/capabilities/next-phase, is deterministic
// and copy-on-read, never throws, imports ONLY ./mount-registration (no Express/server/production
// wiring), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const P = require(path.join(EDIR, 'production-readiness.js'));
const mountRegistration = require(path.join(EDIR, 'mount-registration.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E6-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(P).sort(), [
    'capabilities', 'getNextPhase', 'getProductionReadiness', 'getStatus', 'health', 'isProductionReady',
  ]);
});

test('E6-2. every export is a function', () => {
  for (const k of Object.keys(P)) assert.equal(typeof P[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isProductionReady — always false, derived from mount-registration
// ---------------------------------------------------------------------------

test('E6-3. isProductionReady always returns false', () => {
  assert.equal(P.isProductionReady(), false);
  assert.equal(P.isProductionReady(), P.isProductionReady());
});

test('E6-4. isProductionReady is derived from mount-registration.isMountRegistrationEnabled()', () => {
  assert.equal(P.isProductionReady(), mountRegistration.isMountRegistrationEnabled());
});

// ---------------------------------------------------------------------------
// getProductionReadiness
// ---------------------------------------------------------------------------

test('E6-5. getProductionReadiness returns the expected descriptor', () => {
  assert.deepEqual(P.getProductionReadiness(), { ready: true, productionReady: false, enabled: false, safe: true });
});

test('E6-6. getProductionReadiness.enabled tracks mount-registration', () => {
  assert.equal(P.getProductionReadiness().enabled, mountRegistration.isMountRegistrationEnabled());
});

test('E6-7. getProductionReadiness returns a FRESH object every call (copy-on-read)', () => {
  const a = P.getProductionReadiness();
  const b = P.getProductionReadiness();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.productionReady = true;
  a.enabled = true;
  assert.deepEqual(P.getProductionReadiness(), { ready: true, productionReady: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E6-8. getStatus returns the expected status', () => {
  assert.deepEqual(P.getStatus(), { enabled: false, productionReady: false, production: false, mode: 'FOUNDATION' });
});

test('E6-9. getStatus.enabled tracks mount-registration', () => {
  assert.equal(P.getStatus().enabled, mountRegistration.isMountRegistrationEnabled());
});

test('E6-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = P.getStatus();
  const b = P.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(P.getStatus(), { enabled: false, productionReady: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E6-11. health returns the expected descriptor', () => {
  assert.deepEqual(P.health(), { ready: true, productionReadinessAvailable: true, enabled: false });
});

test('E6-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = P.health();
  const b = P.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(P.health(), { ready: true, productionReadinessAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E6-13. capabilities returns the expected four entries', () => {
  const caps = P.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'production-readiness', 'mount-registration', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E6-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = P.capabilities();
  const b = P.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = P.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E6-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(P.getNextPhase(), {
    phase: 'WP-20 E7', description: 'Controlled production validation', productionImpact: false,
  });
});

test('E6-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = P.getNextPhase();
  const b = P.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(P.getNextPhase(), {
    phase: 'WP-20 E7', description: 'Controlled production validation', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E6-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(P.isProductionReady(), P.isProductionReady());
  assert.deepEqual(P.getProductionReadiness(), P.getProductionReadiness());
  assert.deepEqual(P.getStatus(), P.getStatus());
  assert.deepEqual(P.health(), P.health());
  assert.deepEqual(P.capabilities(), P.capabilities());
  assert.deepEqual(P.getNextPhase(), P.getNextPhase());
});

test('E6-18. never throws + frozen input unchanged + production stays not-ready regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(P)) noThrow(() => P[k](h, h, h), `P.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(P.isProductionReady(frozen), false);
  assert.equal(P.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-production-wiring + unwired
// ---------------------------------------------------------------------------

test('E6-19. production-readiness.js imports ONLY ./mount-registration and performs no production wiring', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-readiness.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './mount-registration');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'service-registration', 'route-registration', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs production wiring: no app/router creation, mounting, or server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no production/server wiring');
});

test('E6-20. production-readiness is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
