// WP-23 · Phase 8 — Enterprise Document Engine Final Runtime Integration Report tests.
// Verifies the capstone: exact export surface; enabled derives from ./runtime-feature-flag (OFF
// while DOCUMENT_ENGINE_ENABLED unset); the WP-23 Phase 7 production runtime readiness is delegated
// fresh; createFinalRuntimeIntegrationReport assembles enabled/productionRuntimeReadiness/status
// (complete/ready/validated/runtimeReady/adapted/planned/coordinated/prepared/implementationReady/
// registrationReady true, implemented/wired/registered/mounted/production false); next-phase;
// copy-on-read; determinism; never throws; imports ONLY the allowed pair (no Express); performs no
// process.env/Express/registration; route stack never changes; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const F = require(path.join(EDIR, 'final-runtime-integration-report.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const productionRuntimeReadiness = require(path.join(EDIR, 'production-runtime-readiness.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const STATUS = {
  complete: true, ready: true, validated: true, runtimeReady: true, adapted: true, planned: true, coordinated: true, prepared: true,
  implementationReady: true, registrationReady: true,
  implemented: false, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W23P8-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(F).sort(), [
    'capabilities', 'createFinalRuntimeIntegrationReport', 'getNextPhase', 'getProductionRuntimeReadiness', 'getStatus', 'health', 'isFinalRuntimeIntegrationReady',
  ]);
});

test('W23P8-2. every export is a function', () => {
  for (const k of Object.keys(F)) assert.equal(typeof F[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W23P8-3. isFinalRuntimeIntegrationReady derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(F.isFinalRuntimeIntegrationReady(), false);
    assert.equal(F.isFinalRuntimeIntegrationReady(), runtimeFeatureFlag.isEnabled());
  });
});

test('W23P8-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    F.createFinalRuntimeIntegrationReport();
    F.getProductionRuntimeReadiness();
    F.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(F.isFinalRuntimeIntegrationReady(), false);
  });
});

// ---------------------------------------------------------------------------
// getProductionRuntimeReadiness
// ---------------------------------------------------------------------------

test('W23P8-5. getProductionRuntimeReadiness delegates to production-runtime-readiness.createProductionRuntimeReadiness()', () => {
  const pr = F.getProductionRuntimeReadiness();
  assert.deepEqual(Object.keys(pr).sort(), ['enabled', 'runtimeRegistrationValidation', 'status']);
  assert.equal(pr.status.ready, true);
  assert.equal(pr.status.registered, false);
});

test('W23P8-6. getProductionRuntimeReadiness returns a FRESH object every call', () => {
  const a = F.getProductionRuntimeReadiness();
  const b = F.getProductionRuntimeReadiness();
  assert.notEqual(a, b);
  assert.notEqual(a.runtimeRegistrationValidation, b.runtimeRegistrationValidation);
});

test('W23P8-7. getProductionRuntimeReadiness is consistent with production-runtime-readiness directly', () => {
  assert.deepEqual(Object.keys(F.getProductionRuntimeReadiness()).sort(), Object.keys(productionRuntimeReadiness.createProductionRuntimeReadiness()).sort());
});

// ---------------------------------------------------------------------------
// createFinalRuntimeIntegrationReport
// ---------------------------------------------------------------------------

test('W23P8-8. createFinalRuntimeIntegrationReport returns the expected shape', () => {
  withUnset(() => {
    const rep = F.createFinalRuntimeIntegrationReport();
    assert.deepEqual(Object.keys(rep).sort(), ['enabled', 'productionRuntimeReadiness', 'status']);
    assert.equal(rep.enabled, false);
    assert.deepEqual(rep.status, STATUS);
    assert.deepEqual(Object.keys(rep.productionRuntimeReadiness).sort(), ['enabled', 'runtimeRegistrationValidation', 'status']);
  });
});

test('W23P8-9. createFinalRuntimeIntegrationReport wires the entire prepared chain end-to-end down to the WP-19 router/controller', () => {
  const rep = F.createFinalRuntimeIntegrationReport();
  const chain = rep.productionRuntimeReadiness.runtimeRegistrationValidation.runtimeRegistration.expressRegistrationAdapter.expressMountAdapter.mountImplementationPlan.coordinator.goLiveReport.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W23P8-10. createFinalRuntimeIntegrationReport: complete/ready/validated/runtimeReady/implementationReady/registrationReady true, implemented/wired/registered/mounted/production false, integrates nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const rep = F.createFinalRuntimeIntegrationReport();
  assert.equal(rep.status.complete, true);
  assert.equal(rep.status.ready, true);
  assert.equal(rep.status.validated, true);
  assert.equal(rep.status.runtimeReady, true);
  assert.equal(rep.status.implementationReady, true);
  assert.equal(rep.status.registrationReady, true);
  assert.equal(rep.status.implemented, false);
  assert.equal(rep.status.wired, false);
  assert.equal(rep.status.registered, false);
  assert.equal(rep.status.mounted, false);
  assert.equal(rep.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing integrated');
});

test('W23P8-11. createFinalRuntimeIntegrationReport returns a FRESH object with fresh readiness/status every call', () => {
  const a = F.createFinalRuntimeIntegrationReport();
  const b = F.createFinalRuntimeIntegrationReport();
  assert.notEqual(a, b);
  assert.notEqual(a.productionRuntimeReadiness, b.productionRuntimeReadiness);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W23P8-12. getStatus returns the status shape plus enabled + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(F.getStatus(), { enabled: false, ...STATUS });
  });
  const a = F.getStatus();
  const b = F.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(F.getStatus().mode, 'FOUNDATION');
});

test('W23P8-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(F.health(), { ready: true, enabled: false, finalRuntimeIntegrationReportAvailable: true });
  });
  const a = F.health();
  const b = F.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(F.health().ready, true);
});

test('W23P8-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = F.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'final-runtime-integration-report', 'production-runtime-readiness', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = F.capabilities();
  const b = F.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(F.capabilities()[0].available, true);
});

test('W23P8-15. getNextPhase returns the WP-24 descriptor (closes WP-23) + fresh copy', () => {
  assert.deepEqual(F.getNextPhase(), {
    phase: 'WP-24 Phase 1', description: 'Controlled Live Server Integration', productionImpact: false,
  });
  const a = F.getNextPhase();
  const b = F.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(F.getNextPhase().phase, 'WP-24 Phase 1');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W23P8-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(F.isFinalRuntimeIntegrationReady(), F.isFinalRuntimeIntegrationReady());
    assert.deepEqual(F.getProductionRuntimeReadiness(), F.getProductionRuntimeReadiness());
    assert.deepEqual(F.createFinalRuntimeIntegrationReport(), F.createFinalRuntimeIntegrationReport());
    assert.deepEqual(F.getStatus(), F.getStatus());
    assert.deepEqual(F.health(), F.health());
    assert.deepEqual(F.capabilities(), F.capabilities());
    assert.deepEqual(F.getNextPhase(), F.getNextPhase());
  });
});

test('W23P8-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(F)) noThrow(() => F[k](h, h, h), `F.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', registered: true });
    assert.equal(F.isFinalRuntimeIntegrationReady(frozen), false);
    assert.equal(F.getStatus(frozen).registered, false);
    assert.equal(F.createFinalRuntimeIntegrationReport(frozen).status.registered, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', registered: true });
  });
});

test('W23P8-18. runtime flag enabled still integrates nothing (route stack unchanged); implemented/production stay OFF', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const rep = F.createFinalRuntimeIntegrationReport();
    assert.equal(rep.enabled, true); // derives from runtime flag
    assert.equal(rep.status.complete, true);
    assert.equal(rep.status.implemented, false); // still never implemented
    assert.equal(rep.status.registered, false); // still never registered
    assert.equal(rep.status.mounted, false);
    assert.equal(rep.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired
// ---------------------------------------------------------------------------

test('W23P8-19. imports ONLY the allowed pair, does NOT import Express, and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'final-runtime-integration-report.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-runtime-readiness', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/integration/server wiring');
});

test('W23P8-20. final runtime integration report is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
