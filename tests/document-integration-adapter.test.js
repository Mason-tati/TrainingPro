// WP-20 · E2 — Enterprise Feature-Gated Integration Adapter tests.
// Verifies the isolated integration-adapter: it exposes exactly the six adapter functions, always
// reports integration disabled (derived from ./feature-flag.isEnabled()), produces the expected
// fresh status/integration/health/capabilities/next-phase, is deterministic and copy-on-read,
// never throws, imports ONLY ./feature-flag (no Express/server/routes/controller/repository), and
// is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'integration-adapter.js'));
const flag = require(path.join(EDIR, 'feature-flag.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E2-1. export surface is exact (six adapter functions)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'capabilities', 'getIntegration', 'getNextPhase', 'getStatus', 'health', 'isIntegrationEnabled',
  ]);
});

test('E2-2. every export is a function', () => {
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isIntegrationEnabled — always disabled, derived from the flag
// ---------------------------------------------------------------------------

test('E2-3. isIntegrationEnabled always returns false', () => {
  assert.equal(A.isIntegrationEnabled(), false);
  assert.equal(A.isIntegrationEnabled(), A.isIntegrationEnabled());
});

test('E2-4. isIntegrationEnabled is derived from feature-flag.isEnabled()', () => {
  assert.equal(A.isIntegrationEnabled(), flag.isEnabled());
  // even after calling the flag's (stateless) enable(), the adapter stays disabled
  flag.enable();
  assert.equal(A.isIntegrationEnabled(), false);
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E2-5. getStatus returns the expected status', () => {
  assert.deepEqual(A.getStatus(), { enabled: false, mode: 'FOUNDATION', production: false, integration: false });
});

test('E2-6. getStatus.enabled tracks feature-flag.isEnabled()', () => {
  assert.equal(A.getStatus().enabled, flag.isEnabled());
});

test('E2-7. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = A.getStatus();
  const b = A.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  a.integration = true;
  assert.deepEqual(A.getStatus(), { enabled: false, mode: 'FOUNDATION', production: false, integration: false });
});

// ---------------------------------------------------------------------------
// getIntegration
// ---------------------------------------------------------------------------

test('E2-8. getIntegration returns the expected descriptor', () => {
  assert.deepEqual(A.getIntegration(), { ready: true, enabled: false, mounted: false, safe: true });
});

test('E2-9. getIntegration.enabled tracks feature-flag.isEnabled()', () => {
  assert.equal(A.getIntegration().enabled, flag.isEnabled());
});

test('E2-10. getIntegration returns a FRESH object every call (copy-on-read)', () => {
  const a = A.getIntegration();
  const b = A.getIntegration();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mounted = true;
  assert.deepEqual(A.getIntegration(), { ready: true, enabled: false, mounted: false, safe: true });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E2-11. health returns the expected descriptor', () => {
  assert.deepEqual(A.health(), { ready: true, enabled: false, healthy: true });
});

test('E2-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = A.health();
  const b = A.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(A.health(), { ready: true, enabled: false, healthy: true });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E2-13. capabilities returns the expected four entries', () => {
  const caps = A.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'feature-gate', 'integration-adapter', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E2-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
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

test('E2-15. getNextPhase returns the expected descriptor', () => {
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-20 E3', description: 'Controlled service registration', productionImpact: false,
  });
});

test('E2-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = A.getNextPhase();
  const b = A.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(A.getNextPhase(), {
    phase: 'WP-20 E3', description: 'Controlled service registration', productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E2-17. deterministic + never throws under hostile/frozen args', () => {
  assert.deepEqual(A.getStatus(), A.getStatus());
  assert.deepEqual(A.getIntegration(), A.getIntegration());
  assert.deepEqual(A.health(), A.health());
  assert.deepEqual(A.capabilities(), A.capabilities());
  assert.deepEqual(A.getNextPhase(), A.getNextPhase());
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(A)) noThrow(() => A[k](h, h, h), `A.${k}`);
  }
});

test('E2-18. frozen input is not mutated + integration stays disabled regardless of args', () => {
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(A.isIntegrationEnabled(frozen), false);
  assert.equal(A.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E2-19. integration-adapter.js imports ONLY ./feature-flag and no forbidden surfaces', () => {
  const src = fs.readFileSync(path.join(EDIR, 'integration-adapter.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './runtime-feature-flag');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'mounting']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  assert.ok(!/\bapp\.use\(|\.listen\(|createServer|express\.Router\(/.test(src), 'no server/mount wiring');
});

test('E2-20. adapter is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
