// WP-22 · Phase 8 — Final Production Wiring & Go-Live Readiness Report tests.
// (Module lives at lib/document-engine/final-go-live-readiness-report.js — collision-free name that
// avoids the approved WP-21 Phase 8 final-production-integration-report module.)
//
// Verifies: exact export surface; enabled derives from ./runtime-feature-flag (OFF while
// DOCUMENT_ENGINE_ENABLED unset); the Phase 7 production readiness is delegated fresh;
// createGoLiveReport assembles enabled/productionReadiness/status (reported/ready/prepared/validated
// true, wired/registered/mounted/production false); next-phase; copy-on-read; determinism; never
// throws; imports ONLY the allowed pair; performs no process.env/Express/wiring; route stack never
// changes; unwired; and the approved WP-21 final report module remains untouched.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'final-go-live-readiness-report.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const productionGoLiveReadiness = require(path.join(EDIR, 'production-go-live-readiness.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// Run `fn` with DOCUMENT_ENGINE_ENABLED unset (restore afterwards).
function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

const FULL_STATUS = {
  reported: true, ready: true, prepared: true, validated: true,
  wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
};

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W8-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(R).sort(), [
    'capabilities', 'createGoLiveReport', 'getNextPhase', 'getProductionReadiness', 'getStatus', 'health', 'isGoLiveReady',
  ]);
});

test('W8-2. every export is a function', () => {
  for (const k of Object.keys(R)) assert.equal(typeof R[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W8-3. isGoLiveReady derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(R.isGoLiveReady(), false);
    assert.equal(R.isGoLiveReady(), runtimeFeatureFlag.isEnabled());
  });
});

test('W8-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    R.createGoLiveReport();
    R.getProductionReadiness();
    R.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(R.isGoLiveReady(), false);
  });
});

// ---------------------------------------------------------------------------
// getProductionReadiness
// ---------------------------------------------------------------------------

test('W8-5. getProductionReadiness delegates to production-go-live-readiness.createProductionReadiness()', () => {
  const pr = R.getProductionReadiness();
  assert.deepEqual(Object.keys(pr).sort(), ['enabled', 'serverWiring', 'status']);
  assert.deepEqual(pr.status, {
    ready: true, prepared: true, validated: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
  });
});

test('W8-6. getProductionReadiness returns a FRESH object every call', () => {
  const a = R.getProductionReadiness();
  const b = R.getProductionReadiness();
  assert.notEqual(a, b);
  assert.notEqual(a.serverWiring, b.serverWiring);
});

test('W8-7. getProductionReadiness is consistent with production-go-live-readiness directly', () => {
  assert.deepEqual(Object.keys(R.getProductionReadiness()).sort(), Object.keys(productionGoLiveReadiness.createProductionReadiness()).sort());
});

// ---------------------------------------------------------------------------
// createGoLiveReport
// ---------------------------------------------------------------------------

test('W8-8. createGoLiveReport returns the expected shape', () => {
  withUnset(() => {
    const rep = R.createGoLiveReport();
    assert.deepEqual(Object.keys(rep).sort(), ['enabled', 'productionReadiness', 'status']);
    assert.equal(rep.enabled, false);
    assert.deepEqual(rep.status, FULL_STATUS);
    assert.deepEqual(Object.keys(rep.productionReadiness).sort(), ['enabled', 'serverWiring', 'status']);
  });
});

test('W8-9. createGoLiveReport wires the entire prepared chain end-to-end (readiness → wiring → validation → registration → mount → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const rep = R.createGoLiveReport();
  const chain = rep.productionReadiness.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W8-10. createGoLiveReport: reported/ready/prepared/validated true, wired/registered/mounted/production false, wires nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const rep = R.createGoLiveReport();
  assert.equal(rep.status.reported, true);
  assert.equal(rep.status.ready, true);
  assert.equal(rep.status.prepared, true);
  assert.equal(rep.status.validated, true);
  assert.equal(rep.status.wired, false);
  assert.equal(rep.status.registered, false);
  assert.equal(rep.status.mounted, false);
  assert.equal(rep.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing wired');
});

test('W8-11. createGoLiveReport returns a FRESH object with fresh productionReadiness/status every call', () => {
  const a = R.createGoLiveReport();
  const b = R.createGoLiveReport();
  assert.notEqual(a, b);
  assert.notEqual(a.productionReadiness, b.productionReadiness);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W8-12. getStatus returns the expected status + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(R.getStatus(), { enabled: false, ...FULL_STATUS });
  });
  const a = R.getStatus();
  const b = R.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(R.getStatus().mode, 'FOUNDATION');
});

test('W8-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(R.health(), { ready: true, enabled: false, reportAvailable: true });
  });
  const a = R.health();
  const b = R.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(R.health().ready, true);
});

test('W8-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = R.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'final-go-live-readiness-report', 'production-go-live-readiness', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = R.capabilities();
  const b = R.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(R.capabilities()[0].available, true);
});

test('W8-15. getNextPhase returns the terminal descriptor (future PO-approved wiring) + fresh copy', () => {
  assert.deepEqual(R.getNextPhase(), {
    phase: 'Future Production Wiring',
    description: 'Requires explicit Product Owner approval before any runtime integration or go-live',
    productionImpact: false,
  });
  const a = R.getNextPhase();
  const b = R.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(R.getNextPhase().phase, 'Future Production Wiring');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W8-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(R.isGoLiveReady(), R.isGoLiveReady());
    assert.deepEqual(R.getProductionReadiness(), R.getProductionReadiness());
    assert.deepEqual(R.createGoLiveReport(), R.createGoLiveReport());
    assert.deepEqual(R.getStatus(), R.getStatus());
    assert.deepEqual(R.health(), R.health());
    assert.deepEqual(R.capabilities(), R.capabilities());
    assert.deepEqual(R.getNextPhase(), R.getNextPhase());
  });
});

test('W8-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(R)) noThrow(() => R[k](h, h, h), `R.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', wired: true });
    assert.equal(R.isGoLiveReady(frozen), false);
    assert.equal(R.getStatus(frozen).wired, false);
    assert.equal(R.createGoLiveReport(frozen).status.wired, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', wired: true });
  });
});

test('W8-18. runtime flag enabled still never wires anything (route stack unchanged)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const rep = R.createGoLiveReport();
    assert.equal(rep.enabled, true); // derives from runtime flag
    assert.equal(rep.status.reported, true);
    assert.equal(rep.status.wired, false); // still never wired
    assert.equal(rep.status.registered, false);
    assert.equal(rep.status.mounted, false);
    assert.equal(rep.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired + WP-21 module untouched
// ---------------------------------------------------------------------------

test('W8-19. imports ONLY ./runtime-feature-flag + ./production-go-live-readiness and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'final-go-live-readiness-report.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./production-go-live-readiness', './runtime-feature-flag']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/wiring/server wiring');
});

test('W8-20. UNWIRED, and the approved WP-21 final-production-integration-report module is untouched', () => {
  // no production consumer imports lib/document-engine
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
  // the WP-21 Phase 8 final report module still exists with its original API (not overwritten)
  const wp21 = require(path.join(EDIR, 'final-production-integration-report.js'));
  assert.equal(typeof wp21.createFinalReport, 'function', 'WP-21 createFinalReport intact');
  assert.equal(typeof wp21.isFinalReportEnabled, 'function', 'WP-21 API intact');
  assert.equal(typeof R.createGoLiveReport, 'function', 'WP-22 go-live report module distinct');
});
