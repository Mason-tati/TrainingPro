// WP-20 · E3 — Enterprise Controlled Service Registration tests.
// Verifies the isolated service-registration module: it exposes exactly the six functions, always
// reports registration disabled (derived from ./integration-adapter.isIntegrationEnabled()),
// produces the expected fresh registration/status/health/capabilities/next-phase, is deterministic
// and copy-on-read, never throws, imports ONLY ./integration-adapter (no Express/server/routes/
// controller/service/repository/engine), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const S = require(path.join(EDIR, 'service-registration.js'));
const adapter = require(path.join(EDIR, 'integration-adapter.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E3-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'capabilities', 'getNextPhase', 'getRegistration', 'getStatus', 'health', 'isRegistrationEnabled',
  ]);
});

test('E3-2. every export is a function', () => {
  for (const k of Object.keys(S)) assert.equal(typeof S[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isRegistrationEnabled — always disabled, derived from the adapter
// ---------------------------------------------------------------------------

test('E3-3. isRegistrationEnabled always returns false', () => {
  assert.equal(S.isRegistrationEnabled(), false);
  assert.equal(S.isRegistrationEnabled(), S.isRegistrationEnabled());
});

test('E3-4. isRegistrationEnabled is derived from integration-adapter.isIntegrationEnabled()', () => {
  assert.equal(S.isRegistrationEnabled(), adapter.isIntegrationEnabled());
});

// ---------------------------------------------------------------------------
// getRegistration
// ---------------------------------------------------------------------------

test('E3-5. getRegistration returns the expected descriptor', () => {
  assert.deepEqual(S.getRegistration(), { ready: true, registered: false, enabled: false, safe: true });
});

test('E3-6. getRegistration.enabled tracks the adapter', () => {
  assert.equal(S.getRegistration().enabled, adapter.isIntegrationEnabled());
});

test('E3-7. getRegistration returns a FRESH object every call (copy-on-read)', () => {
  const a = S.getRegistration();
  const b = S.getRegistration();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.registered = true;
  a.enabled = true;
  assert.deepEqual(S.getRegistration(), { ready: true, registered: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E3-8. getStatus returns the expected status', () => {
  assert.deepEqual(S.getStatus(), { enabled: false, registered: false, production: false, mode: 'FOUNDATION' });
});

test('E3-9. getStatus.enabled tracks the adapter', () => {
  assert.equal(S.getStatus().enabled, adapter.isIntegrationEnabled());
});

test('E3-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = S.getStatus();
  const b = S.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(S.getStatus(), { enabled: false, registered: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E3-11. health returns the expected descriptor', () => {
  assert.deepEqual(S.health(), { ready: true, registrationAvailable: true, enabled: false });
});

test('E3-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = S.health();
  const b = S.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(S.health(), { ready: true, registrationAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E3-13. capabilities returns the expected four entries', () => {
  const caps = S.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'service-registration', 'integration-adapter', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E3-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = S.capabilities();
  const b = S.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = S.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// getNextPhase
// ---------------------------------------------------------------------------

test('E3-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(S.getNextPhase(), {
    phase: 'WP-20 E4', description: 'Controlled route registration', productionImpact: false,
  });
});

test('E3-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = S.getNextPhase();
  const b = S.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(S.getNextPhase(), {
    phase: 'WP-20 E4', description: 'Controlled route registration', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E3-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(S.isRegistrationEnabled(), S.isRegistrationEnabled());
  assert.deepEqual(S.getRegistration(), S.getRegistration());
  assert.deepEqual(S.getStatus(), S.getStatus());
  assert.deepEqual(S.health(), S.health());
  assert.deepEqual(S.capabilities(), S.capabilities());
  assert.deepEqual(S.getNextPhase(), S.getNextPhase());
});

test('E3-18. never throws + frozen input unchanged + registration stays disabled regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(S)) noThrow(() => S[k](h, h, h), `S.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(S.isRegistrationEnabled(frozen), false);
  assert.equal(S.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E3-19. service-registration.js imports ONLY ./integration-adapter and no forbidden surfaces', () => {
  const src = fs.readFileSync(path.join(EDIR, 'service-registration.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './integration-adapter');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'mounting']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  assert.ok(!/\bapp\.use\(|\.listen\(|createServer|express\.Router\(/.test(src), 'no server/mount wiring');
});

test('E3-20. registration module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
