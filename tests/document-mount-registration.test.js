// WP-20 · E5 — Enterprise Controlled Mount Registration tests.
// Verifies the isolated mount-registration module: it exposes exactly the six functions, always
// reports mount registration disabled (derived from ./route-registration.isRouteRegistrationEnabled()),
// produces the expected fresh registration/status/health/capabilities/next-phase, is deterministic
// and copy-on-read, never throws, imports ONLY ./route-registration (no Express/server/mount wiring),
// and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'mount-registration.js'));
const routeRegistration = require(path.join(EDIR, 'route-registration.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E5-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'getMountRegistration', 'getNextPhase', 'getStatus', 'health', 'isMountRegistrationEnabled',
  ]);
});

test('E5-2. every export is a function', () => {
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isMountRegistrationEnabled — always disabled, derived from route-registration
// ---------------------------------------------------------------------------

test('E5-3. isMountRegistrationEnabled always returns false', () => {
  assert.equal(M.isMountRegistrationEnabled(), false);
  assert.equal(M.isMountRegistrationEnabled(), M.isMountRegistrationEnabled());
});

test('E5-4. isMountRegistrationEnabled is derived from route-registration.isRouteRegistrationEnabled()', () => {
  assert.equal(M.isMountRegistrationEnabled(), routeRegistration.isRouteRegistrationEnabled());
});

// ---------------------------------------------------------------------------
// getMountRegistration
// ---------------------------------------------------------------------------

test('E5-5. getMountRegistration returns the expected descriptor', () => {
  assert.deepEqual(M.getMountRegistration(), { ready: true, mounted: false, enabled: false, safe: true });
});

test('E5-6. getMountRegistration.enabled tracks route-registration', () => {
  assert.equal(M.getMountRegistration().enabled, routeRegistration.isRouteRegistrationEnabled());
});

test('E5-7. getMountRegistration returns a FRESH object every call (copy-on-read)', () => {
  const a = M.getMountRegistration();
  const b = M.getMountRegistration();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.mounted = true;
  a.enabled = true;
  assert.deepEqual(M.getMountRegistration(), { ready: true, mounted: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E5-8. getStatus returns the expected status', () => {
  assert.deepEqual(M.getStatus(), { enabled: false, mounted: false, production: false, mode: 'FOUNDATION' });
});

test('E5-9. getStatus.enabled tracks route-registration', () => {
  assert.equal(M.getStatus().enabled, routeRegistration.isRouteRegistrationEnabled());
});

test('E5-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = M.getStatus();
  const b = M.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(M.getStatus(), { enabled: false, mounted: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E5-11. health returns the expected descriptor', () => {
  assert.deepEqual(M.health(), { ready: true, mountRegistrationAvailable: true, enabled: false });
});

test('E5-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = M.health();
  const b = M.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(M.health(), { ready: true, mountRegistrationAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E5-13. capabilities returns the expected four entries', () => {
  const caps = M.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'mount-registration', 'route-registration', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E5-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = M.capabilities();
  const b = M.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = M.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E5-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(M.getNextPhase(), {
    phase: 'WP-20 E6', description: 'Controlled production readiness', productionImpact: false,
  });
});

test('E5-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = M.getNextPhase();
  const b = M.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(M.getNextPhase(), {
    phase: 'WP-20 E6', description: 'Controlled production readiness', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E5-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(M.isMountRegistrationEnabled(), M.isMountRegistrationEnabled());
  assert.deepEqual(M.getMountRegistration(), M.getMountRegistration());
  assert.deepEqual(M.getStatus(), M.getStatus());
  assert.deepEqual(M.health(), M.health());
  assert.deepEqual(M.capabilities(), M.capabilities());
  assert.deepEqual(M.getNextPhase(), M.getNextPhase());
});

test('E5-18. never throws + frozen input unchanged + mount registration stays disabled regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(M)) noThrow(() => M[k](h, h, h), `M.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(M.isMountRegistrationEnabled(frozen), false);
  assert.equal(M.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-mounting + unwired
// ---------------------------------------------------------------------------

test('E5-19. mount-registration.js imports ONLY ./route-registration and performs no mounting', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mount-registration.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './route-registration');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'service-registration', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs mounting / router creation / server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no mount/server wiring');
});

test('E5-20. mount-registration is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
