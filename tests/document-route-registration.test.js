// WP-20 · E4 — Enterprise Controlled Route Registration tests.
// Verifies the isolated route-registration module: it exposes exactly the six functions, always
// reports route registration disabled (derived from ./service-registration.isRegistrationEnabled()),
// produces the expected fresh registration/status/health/capabilities/next-phase, is deterministic
// and copy-on-read, never throws, imports ONLY ./service-registration (no Express/server/routes/
// registration wiring), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'route-registration.js'));
const serviceRegistration = require(path.join(EDIR, 'service-registration.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E4-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(R).sort(), [
    'capabilities', 'getNextPhase', 'getRouteRegistration', 'getStatus', 'health', 'isRouteRegistrationEnabled',
  ]);
});

test('E4-2. every export is a function', () => {
  for (const k of Object.keys(R)) assert.equal(typeof R[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isRouteRegistrationEnabled — always disabled, derived from service-registration
// ---------------------------------------------------------------------------

test('E4-3. isRouteRegistrationEnabled always returns false', () => {
  assert.equal(R.isRouteRegistrationEnabled(), false);
  assert.equal(R.isRouteRegistrationEnabled(), R.isRouteRegistrationEnabled());
});

test('E4-4. isRouteRegistrationEnabled is derived from service-registration.isRegistrationEnabled()', () => {
  assert.equal(R.isRouteRegistrationEnabled(), serviceRegistration.isRegistrationEnabled());
});

// ---------------------------------------------------------------------------
// getRouteRegistration
// ---------------------------------------------------------------------------

test('E4-5. getRouteRegistration returns the expected descriptor', () => {
  assert.deepEqual(R.getRouteRegistration(), { ready: true, routesRegistered: false, enabled: false, safe: true });
});

test('E4-6. getRouteRegistration.enabled tracks service-registration', () => {
  assert.equal(R.getRouteRegistration().enabled, serviceRegistration.isRegistrationEnabled());
});

test('E4-7. getRouteRegistration returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getRouteRegistration();
  const b = R.getRouteRegistration();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.routesRegistered = true;
  a.enabled = true;
  assert.deepEqual(R.getRouteRegistration(), { ready: true, routesRegistered: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E4-8. getStatus returns the expected status', () => {
  assert.deepEqual(R.getStatus(), { enabled: false, routesRegistered: false, production: false, mode: 'FOUNDATION' });
});

test('E4-9. getStatus.enabled tracks service-registration', () => {
  assert.equal(R.getStatus().enabled, serviceRegistration.isRegistrationEnabled());
});

test('E4-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getStatus();
  const b = R.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(R.getStatus(), { enabled: false, routesRegistered: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E4-11. health returns the expected descriptor', () => {
  assert.deepEqual(R.health(), { ready: true, routeRegistrationAvailable: true, enabled: false });
});

test('E4-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = R.health();
  const b = R.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(R.health(), { ready: true, routeRegistrationAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E4-13. capabilities returns the expected four entries', () => {
  const caps = R.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'route-registration', 'service-registration', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E4-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = R.capabilities();
  const b = R.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = R.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E4-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(R.getNextPhase(), {
    phase: 'WP-20 E5', description: 'Controlled mounting registration', productionImpact: false,
  });
});

test('E4-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getNextPhase();
  const b = R.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(R.getNextPhase(), {
    phase: 'WP-20 E5', description: 'Controlled mounting registration', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E4-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(R.isRouteRegistrationEnabled(), R.isRouteRegistrationEnabled());
  assert.deepEqual(R.getRouteRegistration(), R.getRouteRegistration());
  assert.deepEqual(R.getStatus(), R.getStatus());
  assert.deepEqual(R.health(), R.health());
  assert.deepEqual(R.capabilities(), R.capabilities());
  assert.deepEqual(R.getNextPhase(), R.getNextPhase());
});

test('E4-18. never throws + frozen input unchanged + route registration stays disabled regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(R)) noThrow(() => R[k](h, h, h), `R.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(R.isRouteRegistrationEnabled(frozen), false);
  assert.equal(R.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-registration + unwired
// ---------------------------------------------------------------------------

test('E4-19. route-registration.js imports ONLY ./service-registration and performs no registration', () => {
  const src = fs.readFileSync(path.join(EDIR, 'route-registration.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './service-registration');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs route registration / server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(/.test(src), 'no registration/server wiring');
});

test('E4-20. route-registration is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
