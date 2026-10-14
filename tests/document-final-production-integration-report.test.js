// WP-21 · Phase 8 — Final Enterprise Production Integration Report tests.
// Verifies the final report module: exact export surface; flag-derived disabled state; the Phase 7
// confirmation is delegated fresh; createFinalReport assembles enabled/confirmation/status
// (complete:true, readyForFutureProductionWiring:true, integrated:false); next-phase descriptor;
// copy-on-read; never throws under hostile inputs; imports ONLY ./feature-flag +
// ./production-readiness-confirmation (no express/server/fs/path/sqlite3/etc.); and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const F = require(path.join(EDIR, 'final-production-integration-report.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const productionReadinessConfirmation = require(path.join(EDIR, 'production-readiness-confirmation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P8-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(F).sort(), [
    'capabilities', 'createFinalReport', 'getConfirmation', 'getNextPhase', 'getStatus', 'health', 'isFinalReportEnabled',
  ]);
});

test('P8-2. every export is a function', () => {
  for (const k of Object.keys(F)) assert.equal(typeof F[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P8-3. isFinalReportEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(F.isFinalReportEnabled(), false);
  assert.equal(F.isFinalReportEnabled(), featureFlag.isEnabled());
});

test('P8-4. feature flag remains OFF after exercising the module', () => {
  F.createFinalReport();
  F.getConfirmation();
  F.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(F.isFinalReportEnabled(), false);
});

// ---------------------------------------------------------------------------
// getConfirmation
// ---------------------------------------------------------------------------

test('P8-5. getConfirmation delegates to production-readiness-confirmation.createConfirmation() with the expected shape', () => {
  const conf = F.getConfirmation();
  assert.deepEqual(Object.keys(conf).sort(), ['enabled', 'status', 'validation']);
  assert.equal(conf.enabled, false);
  assert.deepEqual(conf.status, { confirmed: true, integrated: false, production: false, mode: 'FOUNDATION' });
});

test('P8-6. getConfirmation returns a FRESH confirmation every call', () => {
  const a = F.getConfirmation();
  const b = F.getConfirmation();
  assert.notEqual(a, b);
  assert.notEqual(a.validation, b.validation);
});

test('P8-7. getConfirmation is consistent with production-readiness-confirmation directly', () => {
  assert.deepEqual(Object.keys(F.getConfirmation()).sort(), Object.keys(productionReadinessConfirmation.createConfirmation()).sort());
});

// ---------------------------------------------------------------------------
// createFinalReport
// ---------------------------------------------------------------------------

test('P8-8. createFinalReport returns the expected shape', () => {
  const rep = F.createFinalReport();
  assert.deepEqual(Object.keys(rep).sort(), ['confirmation', 'enabled', 'status']);
  assert.equal(rep.enabled, false);
  assert.deepEqual(rep.status, {
    complete: true, readyForFutureProductionWiring: true, integrated: false, production: false, mode: 'FOUNDATION',
  });
  assert.deepEqual(Object.keys(rep.confirmation).sort(), ['enabled', 'status', 'validation']);
});

test('P8-9. createFinalReport wires the full prepared chain (confirmation → validation → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const rep = F.createFinalReport();
  const chain = rep.confirmation.validation.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
  assert.equal(rep.confirmation.status.confirmed, true);
});

test('P8-10. createFinalReport: complete + readyForFutureProductionWiring true, integrated/production false', () => {
  const rep = F.createFinalReport();
  assert.equal(rep.status.complete, true);
  assert.equal(rep.status.readyForFutureProductionWiring, true);
  assert.equal(rep.status.integrated, false);
  assert.equal(rep.status.production, false);
});

test('P8-11. createFinalReport returns a FRESH object with fresh confirmation/status every call', () => {
  const a = F.createFinalReport();
  const b = F.createFinalReport();
  assert.notEqual(a, b);
  assert.notEqual(a.confirmation, b.confirmation);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// health / capabilities / status / next phase
// ---------------------------------------------------------------------------

test('P8-12. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(F.health(), { ready: true, enabled: false, finalReportAvailable: true });
  const a = F.health();
  const b = F.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(F.health().ready, true);
});

test('P8-13. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = F.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'final-production-integration-report', 'readiness-confirmation', 'feature-flag-disabled', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = F.capabilities();
  const b = F.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(F.capabilities()[0].available, true);
});

test('P8-14. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(F.getStatus(), {
    enabled: false, complete: true, readyForFutureProductionWiring: true, integrated: false, production: false, mode: 'FOUNDATION',
  });
  const a = F.getStatus();
  const b = F.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(F.getStatus().mode, 'FOUNDATION');
});

test('P8-15. getNextPhase returns the expected descriptor (future PO-approved wiring) + fresh copy', () => {
  assert.deepEqual(F.getNextPhase(), {
    phase: 'Future Production Wiring',
    description: 'Requires explicit Product Owner approval before any runtime integration',
    productionImpact: false,
  });
  const a = F.getNextPhase();
  const b = F.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(F.getNextPhase().phase, 'Future Production Wiring');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P8-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(F.isFinalReportEnabled(), F.isFinalReportEnabled());
  assert.deepEqual(F.getConfirmation(), F.getConfirmation());
  assert.deepEqual(F.createFinalReport(), F.createFinalReport());
  assert.deepEqual(F.health(), F.health());
  assert.deepEqual(F.capabilities(), F.capabilities());
  assert.deepEqual(F.getStatus(), F.getStatus());
  assert.deepEqual(F.getNextPhase(), F.getNextPhase());
});

test('P8-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(F)) noThrow(() => F[k](h, h, h), `F.${k}`);
  }
  const frozen = Object.freeze({ enabled: 'FORCE_ON', integrated: true, production: true });
  assert.equal(F.isFinalReportEnabled(frozen), false);
  assert.equal(F.getStatus(frozen).integrated, false);
  assert.equal(F.createFinalReport(frozen).status.production, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON', integrated: true, production: true });
});

// ---------------------------------------------------------------------------
// import discipline (whitelist + forbidden) + no runtime behaviour + unwired
// ---------------------------------------------------------------------------

test('P8-18. final-production-integration-report.js imports ONLY ./feature-flag + ./production-readiness-confirmation', () => {
  const src = fs.readFileSync(path.join(EDIR, 'final-production-integration-report.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-readiness-confirmation', './runtime-feature-flag']);
});

test('P8-19. no forbidden imports and no runtime/Express/DB usage in source', () => {
  const src = fs.readFileSync(path.join(EDIR, 'final-production-integration-report.js'), 'utf8');
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'sqlite3', 'dotenv']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  for (const sib of ['controller', 'routes', 'api-bridge', 'guarded-route-mount', 'server-mount-preparation', 'server-integration-plan', 'production-integration-validation', 'production-completion', 'production-activation', 'production-validation', 'production-readiness']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no ./${sib} import`);
  }
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)|process\.env/.test(src), 'no runtime/Express/env usage');
});

test('P8-20. final report module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
