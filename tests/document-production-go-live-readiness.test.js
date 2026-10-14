// WP-22 · Phase 7 — Enterprise Document Engine Controlled Production Readiness Confirmation tests.
// (Module lives at lib/document-engine/production-go-live-readiness.js — the PO-approved unique
// filename that avoids colliding with the WP-21 Phase 7 production-readiness-confirmation module.)
//
// Verifies: exact export surface; enabled derives from ./runtime-feature-flag (OFF while
// DOCUMENT_ENGINE_ENABLED unset); the Phase 6 server wiring is delegated fresh; createProductionReadiness
// assembles enabled/serverWiring/status (ready:true, prepared:true, validated:true, wired:false,
// registered:false, mounted:false); next-phase; copy-on-read; determinism; never throws; imports
// ONLY the allowed pair; performs no process.env/Express/wiring; route stack never changes; unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const G = require(path.join(EDIR, 'production-go-live-readiness.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const serverWiringPreparation = require(path.join(EDIR, 'server-wiring-preparation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// Run `fn` with DOCUMENT_ENGINE_ENABLED unset (restore afterwards).
function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W7-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(G).sort(), [
    'capabilities', 'createProductionReadiness', 'getNextPhase', 'getServerWiring', 'getStatus', 'health', 'isProductionReady',
  ]);
});

test('W7-2. every export is a function', () => {
  for (const k of Object.keys(G)) assert.equal(typeof G[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W7-3. isProductionReady derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(G.isProductionReady(), false);
    assert.equal(G.isProductionReady(), runtimeFeatureFlag.isEnabled());
  });
});

test('W7-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    G.createProductionReadiness();
    G.getServerWiring();
    G.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(G.isProductionReady(), false);
  });
});

// ---------------------------------------------------------------------------
// getServerWiring
// ---------------------------------------------------------------------------

test('W7-5. getServerWiring delegates to server-wiring-preparation.createServerWiring()', () => {
  const sw = G.getServerWiring();
  assert.deepEqual(Object.keys(sw).sort(), ['enabled', 'registrationValidation', 'status']);
  assert.deepEqual(sw.status, {
    prepared: true, validated: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
  });
});

test('W7-6. getServerWiring returns a FRESH object every call', () => {
  const a = G.getServerWiring();
  const b = G.getServerWiring();
  assert.notEqual(a, b);
  assert.notEqual(a.registrationValidation, b.registrationValidation);
});

test('W7-7. getServerWiring is consistent with server-wiring-preparation directly', () => {
  assert.deepEqual(Object.keys(G.getServerWiring()).sort(), Object.keys(serverWiringPreparation.createServerWiring()).sort());
});

// ---------------------------------------------------------------------------
// createProductionReadiness
// ---------------------------------------------------------------------------

test('W7-8. createProductionReadiness returns the expected shape', () => {
  withUnset(() => {
    const pr = G.createProductionReadiness();
    assert.deepEqual(Object.keys(pr).sort(), ['enabled', 'serverWiring', 'status']);
    assert.equal(pr.enabled, false);
    assert.deepEqual(pr.status, {
      ready: true, prepared: true, validated: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
    assert.deepEqual(Object.keys(pr.serverWiring).sort(), ['enabled', 'registrationValidation', 'status']);
  });
});

test('W7-9. createProductionReadiness wires the prepared chain end-to-end (wiring → validation → registration → mount → plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const pr = G.createProductionReadiness();
  const chain = pr.serverWiring.registrationValidation.serverRegistration.productionMount.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W7-10. createProductionReadiness: ready/prepared/validated true, wired/registered/mounted/production false, wires nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const pr = G.createProductionReadiness();
  assert.equal(pr.status.ready, true);
  assert.equal(pr.status.prepared, true);
  assert.equal(pr.status.validated, true);
  assert.equal(pr.status.wired, false);
  assert.equal(pr.status.registered, false);
  assert.equal(pr.status.mounted, false);
  assert.equal(pr.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing wired');
});

test('W7-11. createProductionReadiness returns a FRESH object with fresh serverWiring/status every call', () => {
  const a = G.createProductionReadiness();
  const b = G.createProductionReadiness();
  assert.notEqual(a, b);
  assert.notEqual(a.serverWiring, b.serverWiring);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W7-12. getStatus returns the expected status + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(G.getStatus(), {
      enabled: false, ready: true, prepared: true, validated: true, wired: false, registered: false, mounted: false, production: false, mode: 'FOUNDATION',
    });
  });
  const a = G.getStatus();
  const b = G.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(G.getStatus().mode, 'FOUNDATION');
});

test('W7-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(G.health(), { ready: true, enabled: false, productionReadinessAvailable: true });
  });
  const a = G.health();
  const b = G.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(G.health().ready, true);
});

test('W7-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = G.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-readiness-confirmation', 'server-wiring-preparation', 'runtime-feature-flag', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = G.capabilities();
  const b = G.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(G.capabilities()[0].available, true);
});

test('W7-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(G.getNextPhase(), {
    phase: 'WP-22 Phase 8', description: 'Final Production Wiring & Go-Live Readiness Report', productionImpact: false,
  });
  const a = G.getNextPhase();
  const b = G.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(G.getNextPhase().phase, 'WP-22 Phase 8');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W7-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(G.isProductionReady(), G.isProductionReady());
    assert.deepEqual(G.getServerWiring(), G.getServerWiring());
    assert.deepEqual(G.createProductionReadiness(), G.createProductionReadiness());
    assert.deepEqual(G.getStatus(), G.getStatus());
    assert.deepEqual(G.health(), G.health());
    assert.deepEqual(G.capabilities(), G.capabilities());
    assert.deepEqual(G.getNextPhase(), G.getNextPhase());
  });
});

test('W7-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(G)) noThrow(() => G[k](h, h, h), `G.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', wired: true });
    assert.equal(G.isProductionReady(frozen), false);
    assert.equal(G.getStatus(frozen).wired, false);
    assert.equal(G.createProductionReadiness(frozen).status.wired, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', wired: true });
  });
});

test('W7-18. runtime flag enabled still never wires anything (route stack unchanged)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const pr = G.createProductionReadiness();
    assert.equal(pr.enabled, true); // derives from runtime flag
    assert.equal(pr.status.ready, true);
    assert.equal(pr.status.wired, false); // still never wired
    assert.equal(pr.status.registered, false);
    assert.equal(pr.status.mounted, false);
    assert.equal(pr.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + forbidden API scan + unwired + WP-21 module untouched
// ---------------------------------------------------------------------------

test('W7-19. imports ONLY ./runtime-feature-flag + ./server-wiring-preparation and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-go-live-readiness.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-wiring-preparation']);
  for (const mod of ['express', 'http', 'https', 'fs', 'path', 'dotenv', 'sqlite3', 'better-sqlite3']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no app-root server/app import');
  assert.ok(!/require\(['"][^'"]*database[^'"]*['"]\)/.test(src), 'no database import');
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/wiring/server wiring');
});

test('W7-20. UNWIRED, and the approved WP-21 production-readiness-confirmation module is untouched', () => {
  // no production consumer imports lib/document-engine
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
  // the WP-21 Phase 7 module still exists with its original API (not overwritten by this phase)
  const wp21 = require(path.join(EDIR, 'production-readiness-confirmation.js'));
  assert.equal(typeof wp21.createConfirmation, 'function', 'WP-21 createConfirmation intact');
  assert.equal(typeof wp21.isReadinessConfirmationEnabled, 'function', 'WP-21 API intact');
  assert.equal(typeof G.createProductionReadiness, 'function', 'WP-22 go-live module distinct');
});
