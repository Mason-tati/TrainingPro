// WP-20 · E10 — Enterprise Final Production Integration Report tests.
// Verifies the isolated production-integration-report module: it exposes exactly the six functions,
// always reports integration not complete (derived from
// ./production-completion.isProductionCompletionReady()), produces the expected fresh
// report/status/health/capabilities/next-phase, is deterministic and copy-on-read, never throws,
// imports ONLY ./production-completion (no Express/server/production wiring), and is unwired (no
// production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'production-integration-report.js'));
const productionCompletion = require(path.join(EDIR, 'production-completion.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E10-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(R).sort(), [
    'capabilities', 'getIntegrationReport', 'getNextPhase', 'getStatus', 'health', 'isIntegrationComplete',
  ]);
});

test('E10-2. every export is a function', () => {
  for (const k of Object.keys(R)) assert.equal(typeof R[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isIntegrationComplete — always false, derived from production-completion
// ---------------------------------------------------------------------------

test('E10-3. isIntegrationComplete always returns false', () => {
  assert.equal(R.isIntegrationComplete(), false);
  assert.equal(R.isIntegrationComplete(), R.isIntegrationComplete());
});

test('E10-4. isIntegrationComplete is derived from production-completion.isProductionCompletionReady()', () => {
  assert.equal(R.isIntegrationComplete(), productionCompletion.isProductionCompletionReady());
});

// ---------------------------------------------------------------------------
// getIntegrationReport
// ---------------------------------------------------------------------------

test('E10-5. getIntegrationReport returns the expected descriptor', () => {
  assert.deepEqual(R.getIntegrationReport(), { ready: true, integrationComplete: false, enabled: false, safe: true });
});

test('E10-6. getIntegrationReport.enabled tracks production-completion', () => {
  assert.equal(R.getIntegrationReport().enabled, productionCompletion.isProductionCompletionReady());
});

test('E10-7. getIntegrationReport returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getIntegrationReport();
  const b = R.getIntegrationReport();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.integrationComplete = true;
  a.enabled = true;
  assert.deepEqual(R.getIntegrationReport(), { ready: true, integrationComplete: false, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E10-8. getStatus returns the expected status', () => {
  assert.deepEqual(R.getStatus(), { enabled: false, integrationComplete: false, production: false, mode: 'FOUNDATION' });
});

test('E10-9. getStatus.enabled tracks production-completion', () => {
  assert.equal(R.getStatus().enabled, productionCompletion.isProductionCompletionReady());
});

test('E10-10. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getStatus();
  const b = R.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  assert.deepEqual(R.getStatus(), { enabled: false, integrationComplete: false, production: false, mode: 'FOUNDATION' });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E10-11. health returns the expected descriptor', () => {
  assert.deepEqual(R.health(), { ready: true, productionIntegrationReportAvailable: true, enabled: false });
});

test('E10-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = R.health();
  const b = R.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(R.health(), { ready: true, productionIntegrationReportAvailable: true, enabled: false });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E10-13. capabilities returns the expected four entries', () => {
  const caps = R.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'production-integration-report', 'production-completion', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E10-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
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
// getNextPhase — closes WP-20, points to WP-21
// ---------------------------------------------------------------------------

test('E10-15. getNextPhase returns the WP-21 descriptor (closes WP-20)', () => {
  assert.deepEqual(R.getNextPhase(), {
    phase: 'WP-21',
    description: 'Future Production Wiring (Product Owner approval required)',
    productionImpact: false,
  });
});

test('E10-16. getNextPhase returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getNextPhase();
  const b = R.getNextPhase();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.phase = 'HACKED';
  a.productionImpact = true;
  assert.deepEqual(R.getNextPhase(), {
    phase: 'WP-21',
    description: 'Future Production Wiring (Product Owner approval required)',
    productionImpact: false,
  });
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E10-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(R.isIntegrationComplete(), R.isIntegrationComplete());
  assert.deepEqual(R.getIntegrationReport(), R.getIntegrationReport());
  assert.deepEqual(R.getStatus(), R.getStatus());
  assert.deepEqual(R.health(), R.health());
  assert.deepEqual(R.capabilities(), R.capabilities());
  assert.deepEqual(R.getNextPhase(), R.getNextPhase());
});

test('E10-18. never throws + frozen input unchanged + integration stays incomplete regardless of args', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const h of hostile) {
    for (const k of Object.keys(R)) noThrow(() => R[k](h, h, h), `R.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(R.isIntegrationComplete(frozen), false);
  assert.equal(R.getStatus(frozen).enabled, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline + no-production-wiring + unwired
// ---------------------------------------------------------------------------

test('E10-19. production-integration-report.js imports ONLY ./production-completion and performs no production wiring', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-integration-report.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './production-completion');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'document-engine', 'feature-flag', 'integration-adapter', 'service-registration', 'route-registration', 'mount-registration', 'production-readiness', 'production-validation', 'production-activation', 'mounting', 'mounting-report', 'integration-contract', 'readiness-gate', 'completion-report']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  // never performs production wiring: no app/router creation, mounting, or server interaction
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no production/server wiring');
});

test('E10-20. report module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
