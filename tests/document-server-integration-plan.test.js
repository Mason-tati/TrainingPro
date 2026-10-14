// WP-21 · Phase 5 — Enterprise Feature-Gated Server Integration Planning tests.
// Verifies the integration-plan module: exact export surface; flag-derived disabled state; the
// Phase 4 server mount is delegated fresh; createIntegrationPlan assembles enabled/serverMount/
// status (planned:true, integrated:false); next-phase descriptor; copy-on-read; never throws under
// hostile inputs; imports ONLY ./feature-flag + ./server-mount-preparation; performs no Express
// registration / server modification in source; and is unwired (no production consumer imports it).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const P = require(path.join(EDIR, 'server-integration-plan.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const serverMountPreparation = require(path.join(EDIR, 'server-mount-preparation.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P5-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(P).sort(), [
    'capabilities', 'createIntegrationPlan', 'getNextPhase', 'getServerMount', 'getStatus', 'health', 'isIntegrationPlanningEnabled',
  ]);
});

test('P5-2. every export is a function', () => {
  for (const k of Object.keys(P)) assert.equal(typeof P[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P5-3. isIntegrationPlanningEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(P.isIntegrationPlanningEnabled(), false);
  assert.equal(P.isIntegrationPlanningEnabled(), featureFlag.isEnabled());
});

test('P5-4. feature flag remains OFF after exercising the module', () => {
  P.createIntegrationPlan();
  P.getServerMount();
  P.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(P.isIntegrationPlanningEnabled(), false);
});

// ---------------------------------------------------------------------------
// getServerMount
// ---------------------------------------------------------------------------

test('P5-5. getServerMount delegates to server-mount-preparation.createServerMount() with the expected shape', () => {
  const sm = P.getServerMount();
  assert.deepEqual(Object.keys(sm).sort(), ['enabled', 'mount', 'status']);
  assert.equal(sm.enabled, false);
  assert.deepEqual(sm.status, { mounted: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(sm.mount).sort(), ['bridge', 'enabled', 'routes', 'status']);
});

test('P5-6. getServerMount returns a FRESH server mount every call', () => {
  const a = P.getServerMount();
  const b = P.getServerMount();
  assert.notEqual(a, b);
  assert.notEqual(a.mount, b.mount);
});

test('P5-7. getServerMount is consistent with server-mount-preparation directly', () => {
  assert.deepEqual(Object.keys(P.getServerMount()).sort(), Object.keys(serverMountPreparation.createServerMount()).sort());
});

// ---------------------------------------------------------------------------
// createIntegrationPlan
// ---------------------------------------------------------------------------

test('P5-8. createIntegrationPlan returns the expected shape', () => {
  const plan = P.createIntegrationPlan();
  assert.deepEqual(Object.keys(plan).sort(), ['enabled', 'serverMount', 'status']);
  assert.equal(plan.enabled, false);
  assert.deepEqual(plan.status, { planned: true, integrated: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(plan.serverMount).sort(), ['enabled', 'mount', 'status']);
});

test('P5-9. createIntegrationPlan wires the full dependency chain (serverMount → mount → bridge → routes/controller/composition)', () => {
  const plan = P.createIntegrationPlan();
  assert.equal(typeof plan.serverMount.mount.routes, 'function'); // WP-19 router
  assert.equal(typeof plan.serverMount.mount.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in plan.serverMount.mount.bridge); // Phase 1/2 persistence graph
  assert.equal(plan.serverMount.enabled, false);
});

test('P5-10. createIntegrationPlan: planned true, integrated/production false', () => {
  const plan = P.createIntegrationPlan();
  assert.equal(plan.status.planned, true);
  assert.equal(plan.status.integrated, false);
  assert.equal(plan.status.production, false);
});

test('P5-11. createIntegrationPlan returns a FRESH object with fresh serverMount/status every call', () => {
  const a = P.createIntegrationPlan();
  const b = P.createIntegrationPlan();
  assert.notEqual(a, b);
  assert.notEqual(a.serverMount, b.serverMount);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// health / capabilities / status / next phase
// ---------------------------------------------------------------------------

test('P5-12. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(P.health(), { ready: true, enabled: false, planningAvailable: true });
  const a = P.health();
  const b = P.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(P.health().ready, true);
});

test('P5-13. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = P.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'server-mount', 'integration-plan', 'feature-flag-disabled', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = P.capabilities();
  const b = P.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(P.capabilities()[0].available, true);
});

test('P5-14. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(P.getStatus(), { enabled: false, planned: true, integrated: false, production: false, mode: 'FOUNDATION' });
  const a = P.getStatus();
  const b = P.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(P.getStatus().mode, 'FOUNDATION');
});

test('P5-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(P.getNextPhase(), {
    phase: 'WP-21 Phase 6', description: 'Feature-gated production integration validation', productionImpact: false,
  });
  const a = P.getNextPhase();
  const b = P.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(P.getNextPhase().phase, 'WP-21 Phase 6');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P5-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(P.isIntegrationPlanningEnabled(), P.isIntegrationPlanningEnabled());
  assert.deepEqual(P.getServerMount(), P.getServerMount());
  assert.deepEqual(P.createIntegrationPlan(), P.createIntegrationPlan());
  assert.deepEqual(P.health(), P.health());
  assert.deepEqual(P.capabilities(), P.capabilities());
  assert.deepEqual(P.getStatus(), P.getStatus());
  assert.deepEqual(P.getNextPhase(), P.getNextPhase());
});

test('P5-17. never throws under hostile arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(P)) noThrow(() => P[k](h, h, h), `P.${k}`);
  }
});

test('P5-18. enabled/integrated/production stay false regardless of arguments', () => {
  const frozen = Object.freeze({ enabled: 'FORCE_ON', integrated: true, production: true });
  assert.equal(P.isIntegrationPlanningEnabled(frozen), false);
  assert.equal(P.getStatus(frozen).integrated, false);
  assert.equal(P.getStatus(frozen).production, false);
  assert.equal(P.createIntegrationPlan(frozen).status.integrated, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON', integrated: true, production: true });
});

// ---------------------------------------------------------------------------
// import discipline + no-registration + unwired
// ---------------------------------------------------------------------------

test('P5-19. server-integration-plan.js imports ONLY the allowed pair and performs no server/Express registration', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-integration-plan.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-mount-preparation']);
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"]sqlite3['"]\)/.test(src), 'no sqlite3');
  // precise: forbid requiring the app-root server.js/app.js, or any routes/middleware/controllers path segment
  assert.ok(!/require\(['"](\.\.?\/)+(server|app)['"]\)/.test(src), 'no require of app-root server/app');
  assert.ok(!/require\(['"][^'"]*(\/middleware\/|\/controllers?\/|\/routes\/)[^'"]*['"]\)/.test(src), 'no routes/middleware/controllers');
  // never registers / mounts / modifies a server (createServer( with paren avoids matching function names)
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no mount/registration/server wiring');
});

test('P5-20. integration plan is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
