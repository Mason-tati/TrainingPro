// WP-21 · Phase 4 — Enterprise Feature-Gated Server Mount Preparation tests.
// Verifies the server-mount preparation module: exact export surface; flag-derived disabled state;
// the Phase 3 guarded mount is delegated fresh; createServerMount assembles enabled/mount/status;
// next-phase descriptor; copy-on-read; never throws under hostile inputs; imports ONLY
// ./feature-flag + ./guarded-route-mount; performs no Express registration / server modification in
// source; and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const S = require(path.join(EDIR, 'server-mount-preparation.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const guardedRouteMount = require(path.join(EDIR, 'guarded-route-mount.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P4-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(S).sort(), [
    'capabilities', 'createServerMount', 'getGuardedMount', 'getNextPhase', 'getStatus', 'health', 'isServerMountEnabled',
  ]);
});

test('P4-2. every export is a function', () => {
  for (const k of Object.keys(S)) assert.equal(typeof S[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P4-3. isServerMountEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(S.isServerMountEnabled(), false);
  assert.equal(S.isServerMountEnabled(), featureFlag.isEnabled());
});

test('P4-4. feature flag remains OFF after exercising the module', () => {
  S.createServerMount();
  S.getGuardedMount();
  S.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(S.isServerMountEnabled(), false);
});

// ---------------------------------------------------------------------------
// getGuardedMount
// ---------------------------------------------------------------------------

test('P4-5. getGuardedMount delegates to guarded-route-mount.createMount() with the expected shape', () => {
  const mount = S.getGuardedMount();
  assert.deepEqual(Object.keys(mount).sort(), ['bridge', 'enabled', 'routes', 'status']);
  assert.equal(mount.enabled, false);
  assert.equal(typeof mount.routes, 'function'); // WP-19 Express router
  assert.deepEqual(mount.status, { mounted: false, production: false, mode: 'FOUNDATION' });
});

test('P4-6. getGuardedMount returns a FRESH mount (fresh bridge) every call', () => {
  const a = S.getGuardedMount();
  const b = S.getGuardedMount();
  assert.notEqual(a, b);
  assert.notEqual(a.bridge, b.bridge);
  assert.equal(a.routes, b.routes); // routes reference shared (mountable surface)
});

test('P4-7. getGuardedMount is consistent with the guarded route mount directly', () => {
  assert.deepEqual(Object.keys(S.getGuardedMount()).sort(), Object.keys(guardedRouteMount.createMount()).sort());
});

// ---------------------------------------------------------------------------
// createServerMount
// ---------------------------------------------------------------------------

test('P4-8. createServerMount returns the expected shape', () => {
  const sm = S.createServerMount();
  assert.deepEqual(Object.keys(sm).sort(), ['enabled', 'mount', 'status']);
  assert.equal(sm.enabled, false);
  assert.deepEqual(sm.status, { mounted: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(sm.mount).sort(), ['bridge', 'enabled', 'routes', 'status']);
});

test('P4-9. createServerMount wires the full dependency chain (mount → bridge → routes/controller/composition)', () => {
  const sm = S.createServerMount();
  assert.equal(typeof sm.mount.routes, 'function'); // WP-19 router
  assert.equal(typeof sm.mount.bridge.controller.create, 'function'); // WP-19 controller via bridge
  assert.ok('composition' in sm.mount.bridge); // Phase 1/2 persistence graph
  assert.equal(sm.mount.enabled, false);
});

test('P4-10. createServerMount returns a FRESH object with fresh mount/status every call', () => {
  const a = S.createServerMount();
  const b = S.createServerMount();
  assert.notEqual(a, b);
  assert.notEqual(a.mount, b.mount);
  assert.notEqual(a.status, b.status);
});

test('P4-11. createServerMount is production-safe: mounted false, no route stack mutation', () => {
  const before = guardedRouteMount.getRoutes().stack.length;
  const sm = S.createServerMount();
  assert.equal(sm.status.mounted, false);
  assert.equal(sm.mount.status.mounted, false);
  assert.equal(guardedRouteMount.getRoutes().stack.length, before, 'route stack unchanged');
});

// ---------------------------------------------------------------------------
// health / capabilities / status / next phase
// ---------------------------------------------------------------------------

test('P4-12. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(S.health(), { ready: true, enabled: false, mountAvailable: true });
  const a = S.health();
  const b = S.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(S.health().ready, true);
});

test('P4-13. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = S.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'guarded-mount', 'feature-flag-disabled', 'server-mount-preparation', 'production-safe',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = S.capabilities();
  const b = S.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(S.capabilities()[0].available, true);
});

test('P4-14. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(S.getStatus(), { enabled: false, mounted: false, production: false, mode: 'FOUNDATION' });
  const a = S.getStatus();
  const b = S.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(S.getStatus().mode, 'FOUNDATION');
});

test('P4-15. getNextPhase returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(S.getNextPhase(), {
    phase: 'WP-21 Phase 5', description: 'Feature-gated server integration planning', productionImpact: false,
  });
  const a = S.getNextPhase();
  const b = S.getNextPhase();
  assert.notEqual(a, b);
  a.phase = 'HACKED';
  assert.equal(S.getNextPhase().phase, 'WP-21 Phase 5');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P4-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(S.isServerMountEnabled(), S.isServerMountEnabled());
  assert.deepEqual(S.getGuardedMount(), S.getGuardedMount());
  assert.deepEqual(S.createServerMount(), S.createServerMount());
  assert.deepEqual(S.health(), S.health());
  assert.deepEqual(S.capabilities(), S.capabilities());
  assert.deepEqual(S.getStatus(), S.getStatus());
  assert.deepEqual(S.getNextPhase(), S.getNextPhase());
});

test('P4-17. never throws under hostile arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(S)) noThrow(() => S[k](h, h, h), `S.${k}`);
  }
});

test('P4-18. mounted/enabled stay false regardless of arguments', () => {
  const frozen = Object.freeze({ enabled: 'FORCE_ON', mounted: true });
  assert.equal(S.isServerMountEnabled(frozen), false);
  assert.equal(S.getStatus(frozen).mounted, false);
  assert.equal(S.createServerMount(frozen).status.mounted, false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON', mounted: true });
});

// ---------------------------------------------------------------------------
// import discipline + no-registration + unwired
// ---------------------------------------------------------------------------

test('P4-19. server-mount-preparation.js imports ONLY the allowed pair and performs no server/Express registration', () => {
  const src = fs.readFileSync(path.join(EDIR, 'server-mount-preparation.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./guarded-route-mount', './runtime-feature-flag']);
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"]sqlite3['"]\)/.test(src), 'no sqlite3');
  assert.ok(!/require\(['"][^'"]*(\/server\b|\/app\b|\/middleware\/|\/controllers?\/|\/routes\/)[^'"]*['"]\)/.test(src), 'no server/app/middleware/controllers/routes');
  // never registers / mounts / modifies a server
  assert.ok(!/\bapp\.use\(|\brouter\.(use|get|post|put|delete)\(|\.listen\(|createServer\(|express\.Router\(|express\(\)/.test(src), 'no mount/registration/server wiring');
});

test('P4-20. server-mount-preparation is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
