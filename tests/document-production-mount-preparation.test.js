// WP-22 · Phase 3 — Enterprise Document Engine Controlled Production Mount Integration tests.
// Verifies the production-mount-preparation module: exact export surface; enabled derives from
// ./runtime-feature-flag (OFF while DOCUMENT_ENGINE_ENABLED unset); the Phase 5 integration plan is
// delegated fresh; createProductionMount assembles enabled/integrationPlan/status (prepared:true,
// mounted:false); next-phase; copy-on-read; determinism; never throws; imports ONLY the allowed
// pair; performs no process.env/Express/mount/registration; and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'production-mount-preparation.js'));
const runtimeFeatureFlag = require(path.join(EDIR, 'runtime-feature-flag.js'));
const serverIntegrationPlan = require(path.join(EDIR, 'server-integration-plan.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// Ensure the feature flag is OFF for the default assertions (restore afterwards).
function withUnset(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  try { delete process.env.DOCUMENT_ENGINE_ENABLED; return fn(); }
  finally { if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED; }
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W3-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'createProductionMount', 'getIntegrationPlan', 'getNextPhase', 'getStatus', 'health', 'isMountPrepared',
  ]);
});

test('W3-2. every export is a function', () => {
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// runtime-feature-flag derivation (OFF by default)
// ---------------------------------------------------------------------------

test('W3-3. isMountPrepared derives from runtime-feature-flag.isEnabled() and is false by default', () => {
  withUnset(() => {
    assert.equal(M.isMountPrepared(), false);
    assert.equal(M.isMountPrepared(), runtimeFeatureFlag.isEnabled());
  });
});

test('W3-4. feature flag remains OFF after exercising the module', () => {
  withUnset(() => {
    M.createProductionMount();
    M.getIntegrationPlan();
    M.health();
    assert.equal(runtimeFeatureFlag.isEnabled(), false);
    assert.equal(M.isMountPrepared(), false);
  });
});

// ---------------------------------------------------------------------------
// getIntegrationPlan
// ---------------------------------------------------------------------------

test('W3-5. getIntegrationPlan delegates to server-integration-plan.createIntegrationPlan() with the expected shape', () => {
  const plan = M.getIntegrationPlan();
  assert.deepEqual(Object.keys(plan).sort(), ['enabled', 'serverMount', 'status']);
  withUnset(() => assert.equal(M.getIntegrationPlan().enabled, false));
  assert.deepEqual(plan.status, { planned: true, integrated: false, production: false, mode: 'FOUNDATION' });
});

test('W3-6. getIntegrationPlan returns a FRESH plan every call', () => {
  const a = M.getIntegrationPlan();
  const b = M.getIntegrationPlan();
  assert.notEqual(a, b);
  assert.notEqual(a.serverMount, b.serverMount);
});

test('W3-7. getIntegrationPlan is consistent with server-integration-plan directly', () => {
  assert.deepEqual(Object.keys(M.getIntegrationPlan()).sort(), Object.keys(serverIntegrationPlan.createIntegrationPlan()).sort());
});

// ---------------------------------------------------------------------------
// createProductionMount
// ---------------------------------------------------------------------------

test('W3-8. createProductionMount returns the expected shape', () => {
  withUnset(() => {
    const pm = M.createProductionMount();
    assert.deepEqual(Object.keys(pm).sort(), ['enabled', 'integrationPlan', 'status']);
    assert.equal(pm.enabled, false);
    assert.deepEqual(pm.status, { prepared: true, mounted: false, production: false, mode: 'FOUNDATION' });
    assert.deepEqual(Object.keys(pm.integrationPlan).sort(), ['enabled', 'serverMount', 'status']);
  });
});

test('W3-9. createProductionMount wires the prepared chain (plan → serverMount → mount → bridge → routes/controller/composition)', () => {
  const pm = M.createProductionMount();
  const chain = pm.integrationPlan.serverMount.mount;
  assert.equal(typeof chain.routes, 'function'); // WP-19 router
  assert.equal(typeof chain.bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('composition' in chain.bridge); // Phase 1/2 persistence graph
});

test('W3-10. createProductionMount: prepared true, mounted/production false, and mounts nothing', () => {
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  const pm = M.createProductionMount();
  assert.equal(pm.status.prepared, true);
  assert.equal(pm.status.mounted, false);
  assert.equal(pm.status.production, false);
  assert.equal(routes.stack.length, before, 'route stack unchanged — nothing mounted');
});

test('W3-11. createProductionMount returns a FRESH object with fresh integrationPlan/status every call', () => {
  const a = M.createProductionMount();
  const b = M.createProductionMount();
  assert.notEqual(a, b);
  assert.notEqual(a.integrationPlan, b.integrationPlan);
  assert.notEqual(a.status, b.status);
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / next phase
// ---------------------------------------------------------------------------

test('W3-12. getStatus returns the expected status + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(M.getStatus(), { enabled: false, prepared: true, mounted: false, production: false, mode: 'FOUNDATION' });
  });
  const a = M.getStatus();
  const b = M.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(M.getStatus().mode, 'FOUNDATION');
});

test('W3-13. health returns the expected descriptor + fresh copy', () => {
  withUnset(() => {
    assert.deepEqual(M.health(), { ready: true, enabled: false, preparationAvailable: true });
  });
  const a = M.health();
  const b = M.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(M.health().ready, true);
});

test('W3-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = M.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'production-mount-preparation', 'runtime-feature-flag', 'integration-plan', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = M.capabilities();
  const b = M.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(M.capabilities()[0].available, true);
});

test('W3-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(M.getNextPhase(), {
    phase: 'WP-22 Phase 4', description: 'Controlled Server Registration', productionImpact: false,
  });
  const a = M.getNextPhase();
  const b = M.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(M.getNextPhase().phase, 'WP-22 Phase 4');
});

// ---------------------------------------------------------------------------
// determinism + robustness
// ---------------------------------------------------------------------------

test('W3-16. deterministic for a fixed environment', () => {
  withUnset(() => {
    assert.equal(M.isMountPrepared(), M.isMountPrepared());
    assert.deepEqual(M.getIntegrationPlan(), M.getIntegrationPlan());
    assert.deepEqual(M.createProductionMount(), M.createProductionMount());
    assert.deepEqual(M.getStatus(), M.getStatus());
    assert.deepEqual(M.health(), M.health());
    assert.deepEqual(M.capabilities(), M.capabilities());
    assert.deepEqual(M.getNextPhase(), M.getNextPhase());
  });
});

test('W3-17. never throws under hostile + frozen arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  withUnset(() => {
    for (const h of hostile) {
      for (const k of Object.keys(M)) noThrow(() => M[k](h, h, h), `M.${k}`);
    }
    const frozen = Object.freeze({ enabled: 'FORCE_ON', mounted: true });
    assert.equal(M.isMountPrepared(frozen), false);
    assert.equal(M.getStatus(frozen).mounted, false);
    assert.equal(M.createProductionMount(frozen).status.mounted, false);
    assert.deepEqual(frozen, { enabled: 'FORCE_ON', mounted: true });
  });
});

test('W3-18. mounted/production stay false even when the runtime flag is enabled (prepared, never mounted)', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'DOCUMENT_ENGINE_ENABLED');
  const prev = process.env.DOCUMENT_ENGINE_ENABLED;
  const routes = require(path.join(EDIR, 'routes.js'));
  const before = routes.stack.length;
  try {
    process.env.DOCUMENT_ENGINE_ENABLED = 'true';
    const pm = M.createProductionMount();
    assert.equal(pm.enabled, true); // derives from runtime flag
    assert.equal(pm.status.prepared, true);
    assert.equal(pm.status.mounted, false); // still never mounted
    assert.equal(pm.status.production, false);
    assert.equal(routes.stack.length, before, 'route stack unchanged even when enabled');
  } finally {
    if (had) process.env.DOCUMENT_ENGINE_ENABLED = prev; else delete process.env.DOCUMENT_ENGINE_ENABLED;
  }
});

// ---------------------------------------------------------------------------
// import discipline + no forbidden APIs + unwired
// ---------------------------------------------------------------------------

test('W3-19. imports ONLY ./runtime-feature-flag + ./server-integration-plan and uses no forbidden APIs', () => {
  const src = fs.readFileSync(path.join(EDIR, 'production-mount-preparation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./runtime-feature-flag', './server-integration-plan']);
  for (const mod of ['express', 'http', 'https', 'sqlite3', 'fs', 'path', 'dotenv']) {
    assert.ok(!new RegExp(`require\\(['"]${mod}['"]\\)`).test(src), `no require('${mod}')`);
  }
  assert.ok(!/process\.env/.test(src), 'no process.env access (only runtime-feature-flag reads env)');
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no Express/mount/registration wiring');
});

test('W3-20. production mount preparation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
