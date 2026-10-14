// WP-21 · Phase 3 — Enterprise Guarded Route Mount Foundation tests.
// Verifies the guarded mount: exact export surface; flag-derived disabled state; the WP-19 routes
// (Express Router) are returned as-is (no wrapper); the Phase 2 bridge is delegated fresh;
// createMount assembles enabled/routes/bridge/status; copy-on-read; never throws under hostile
// inputs; imports ONLY ./feature-flag + ./api-bridge + ./routes; performs no Express registration
// (no app.use/router.use in source); and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'guarded-route-mount.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const apiBridge = require(path.join(EDIR, 'api-bridge.js'));
const routes = require(path.join(EDIR, 'routes.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P3-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'createMount', 'getBridge', 'getRoutes', 'getStatus', 'health', 'isMountEnabled',
  ]);
});

test('P3-2. every export is a function', () => {
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P3-3. isMountEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(M.isMountEnabled(), false);
  assert.equal(M.isMountEnabled(), featureFlag.isEnabled());
});

test('P3-4. feature flag remains OFF after exercising the module', () => {
  M.createMount();
  M.getBridge();
  M.getRoutes();
  M.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(M.isMountEnabled(), false);
});

// ---------------------------------------------------------------------------
// getRoutes
// ---------------------------------------------------------------------------

test('P3-5. getRoutes returns the existing WP-19 routes (Express Router) as-is', () => {
  assert.equal(M.getRoutes(), routes);
  assert.equal(typeof M.getRoutes(), 'function'); // an Express router is a function
  assert.ok(Array.isArray(M.getRoutes().stack)); // with a route stack
});

test('P3-6. getRoutes is stable and exposes the 19-route stack unchanged', () => {
  assert.equal(M.getRoutes(), M.getRoutes());
  const routeLayers = M.getRoutes().stack.filter((l) => l.route);
  assert.equal(routeLayers.length, 19);
});

// ---------------------------------------------------------------------------
// getBridge
// ---------------------------------------------------------------------------

test('P3-7. getBridge delegates to api-bridge.createBridge() with the expected shape', () => {
  const bridge = M.getBridge();
  assert.deepEqual(Object.keys(bridge).sort(), ['composition', 'controller', 'enabled', 'status']);
  assert.equal(bridge.enabled, false);
  assert.equal(typeof bridge.controller.create, 'function');
});

test('P3-8. getBridge returns a FRESH bridge (fresh composition) every call', () => {
  const a = M.getBridge();
  const b = M.getBridge();
  assert.notEqual(a, b);
  assert.notEqual(a.composition, b.composition);
});

// ---------------------------------------------------------------------------
// createMount
// ---------------------------------------------------------------------------

test('P3-9. createMount returns the expected shape', () => {
  const mount = M.createMount();
  assert.deepEqual(Object.keys(mount).sort(), ['bridge', 'enabled', 'routes', 'status']);
  assert.equal(mount.enabled, false);
  assert.equal(mount.routes, routes);
  assert.deepEqual(mount.status, { mounted: false, production: false, mode: 'FOUNDATION' });
});

test('P3-10. createMount wires the dependency chain routes + bridge(controller→composition)', () => {
  const mount = M.createMount();
  assert.equal(typeof mount.routes, 'function'); // WP-19 router
  assert.equal(typeof mount.bridge.controller.create, 'function'); // WP-19 controller via bridge
  assert.ok('composition' in mount.bridge); // Phase 1/2 persistence graph
  assert.equal(mount.bridge.enabled, false);
});

test('P3-11. createMount returns a FRESH object with a fresh bridge/status every call', () => {
  const a = M.createMount();
  const b = M.createMount();
  assert.notEqual(a, b);
  assert.notEqual(a.bridge, b.bridge);
  assert.notEqual(a.status, b.status);
  assert.equal(a.routes, b.routes); // routes reference intentionally shared (mountable surface)
});

test('P3-12. createMount does not mutate the routes stack (no registration)', () => {
  const before = M.getRoutes().stack.length;
  M.createMount();
  assert.equal(M.getRoutes().stack.length, before, 'route stack unchanged (nothing registered)');
});

// ---------------------------------------------------------------------------
// health / capabilities / status
// ---------------------------------------------------------------------------

test('P3-13. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(M.health(), { ready: true, enabled: false, routesAvailable: true, bridgeAvailable: true });
  const a = M.health();
  const b = M.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(M.health().ready, true);
});

test('P3-14. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = M.capabilities();
  assert.deepEqual(caps.map((c) => c.name), ['routes', 'bridge', 'feature-flag-disabled', 'guarded-mount']);
  assert.ok(caps.every((c) => c.available === true));
  const a = M.capabilities();
  const b = M.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(M.capabilities()[0].available, true);
});

test('P3-15. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(M.getStatus(), { enabled: false, mounted: false, production: false, mode: 'FOUNDATION' });
  const a = M.getStatus();
  const b = M.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(M.getStatus().mode, 'FOUNDATION');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P3-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(M.isMountEnabled(), M.isMountEnabled());
  assert.deepEqual(M.getBridge(), M.getBridge());
  assert.deepEqual(M.createMount(), M.createMount());
  assert.deepEqual(M.health(), M.health());
  assert.deepEqual(M.capabilities(), M.capabilities());
  assert.deepEqual(M.getStatus(), M.getStatus());
});

test('P3-17. never throws under hostile arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(M)) noThrow(() => M[k](h, h, h), `M.${k}`);
  }
});

test('P3-18. mounted stays false regardless of arguments', () => {
  const frozen = Object.freeze({ enabled: 'FORCE_ON', mounted: true });
  assert.equal(M.isMountEnabled(frozen), false);
  assert.equal(M.getStatus(frozen).mounted, false);
  assert.equal(M.createMount(frozen).status.mounted, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON', mounted: true });
});

// ---------------------------------------------------------------------------
// import discipline + no-registration + unwired
// ---------------------------------------------------------------------------

test('P3-19. guarded-route-mount.js imports ONLY the allowed trio and performs no Express registration', () => {
  const src = fs.readFileSync(path.join(EDIR, 'guarded-route-mount.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./api-bridge', './routes', './runtime-feature-flag']);
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no direct express import');
  assert.ok(!/require\(['"]sqlite3['"]\)/.test(src), 'no sqlite3');
  assert.ok(!/require\(['"][^'"]*(\/server\b|\/app\b|\/middleware\/|\/controllers?\/)[^'"]*['"]\)/.test(src), 'no server/app/middleware/controllers');
  // never mounts / registers anything
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer|express\.Router\(|express\(\)/.test(src), 'no mount/registration/server wiring');
});

test('P3-20. guarded mount is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
