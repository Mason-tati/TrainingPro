// WP-21 · Phase 2 — Enterprise Document Engine API ↔ Persistence Bridge tests.
// Verifies the bridge: exact export surface; flag-derived disabled state; the controller is
// returned as-is (no wrapper); the composition is delegated fresh to the Phase 1 wiring root;
// createBridge assembles enabled/controller/composition/status; copy-on-read; never throws under
// hostile inputs; imports ONLY ./feature-flag + ./wiring + ./controller (no Express/routes/server);
// and the bridge is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const B = require(path.join(EDIR, 'api-bridge.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));
const wiring = require(path.join(EDIR, 'wiring.js'));
const controller = require(path.join(EDIR, 'controller.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P2-1. export surface is exact (seven functions)', () => {
  assert.deepEqual(Object.keys(B).sort(), [
    'capabilities', 'createBridge', 'getComposition', 'getController', 'getStatus', 'health', 'isBridgeEnabled',
  ]);
});

test('P2-2. every export is a function', () => {
  for (const k of Object.keys(B)) assert.equal(typeof B[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P2-3. isBridgeEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(B.isBridgeEnabled(), false);
  assert.equal(B.isBridgeEnabled(), featureFlag.isEnabled());
});

test('P2-4. feature flag remains OFF after exercising the module', () => {
  B.createBridge();
  B.getComposition();
  B.getController();
  B.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(B.isBridgeEnabled(), false);
});

// ---------------------------------------------------------------------------
// getController
// ---------------------------------------------------------------------------

test('P2-5. getController returns the existing controller instance (no wrapper)', () => {
  assert.equal(B.getController(), controller);
});

test('P2-6. getController is stable and exposes the controller action surface', () => {
  assert.equal(B.getController(), B.getController());
  const c = B.getController();
  assert.equal(typeof c.create, 'function');
  assert.equal(typeof c.get, 'function');
  assert.equal(typeof c.health, 'function');
});

// ---------------------------------------------------------------------------
// getComposition
// ---------------------------------------------------------------------------

test('P2-7. getComposition delegates to wiring.createComposition() with the expected shape', () => {
  const comp = B.getComposition();
  assert.deepEqual(Object.keys(comp).sort(), ['db', 'enabled', 'repositories', 'services', 'status']);
  assert.equal(comp.enabled, false);
  assert.deepEqual(comp.status, { wired: false, production: false, mode: 'FOUNDATION' });
});

test('P2-8. getComposition returns a FRESH composition every call', () => {
  const a = B.getComposition();
  const b = B.getComposition();
  assert.notEqual(a, b);
  assert.notEqual(a.repositories, b.repositories);
  assert.deepEqual(a.status, b.status);
});

test('P2-9. getComposition is consistent with the wiring root directly', () => {
  assert.deepEqual(Object.keys(B.getComposition()).sort(), Object.keys(wiring.createComposition()).sort());
});

// ---------------------------------------------------------------------------
// createBridge
// ---------------------------------------------------------------------------

test('P2-10. createBridge returns the expected shape', () => {
  const bridge = B.createBridge();
  assert.deepEqual(Object.keys(bridge).sort(), ['composition', 'controller', 'enabled', 'status']);
  assert.equal(bridge.enabled, false);
  assert.equal(bridge.controller, controller);
  assert.deepEqual(bridge.status, { wired: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(bridge.composition).sort(), ['db', 'enabled', 'repositories', 'services', 'status']);
});

test('P2-11. createBridge wires the dependency chain controller → composition(services→repositories)', () => {
  const bridge = B.createBridge();
  assert.equal(typeof bridge.controller.create, 'function'); // WP-19 controller
  assert.ok('services' in bridge.composition && 'repositories' in bridge.composition); // WP-18 via wiring
  assert.equal(bridge.composition.enabled, false);
});

test('P2-12. createBridge returns a FRESH object with a fresh composition/status every call', () => {
  const a = B.createBridge();
  const b = B.createBridge();
  assert.notEqual(a, b);
  assert.notEqual(a.composition, b.composition);
  assert.notEqual(a.status, b.status);
  assert.equal(a.controller, b.controller); // controller reference intentionally shared
});

test('P2-13. createBridge performs no CRUD / mutation of the controller', () => {
  const before = Object.keys(controller).sort();
  B.createBridge();
  assert.deepEqual(Object.keys(controller).sort(), before, 'controller surface unchanged');
});

// ---------------------------------------------------------------------------
// health / capabilities / status
// ---------------------------------------------------------------------------

test('P2-14. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(B.health(), { ready: true, enabled: false, controllerAvailable: true, compositionAvailable: true });
  const a = B.health();
  const b = B.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(B.health().ready, true);
});

test('P2-15. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = B.capabilities();
  assert.deepEqual(caps.map((c) => c.name), ['controller', 'composition', 'feature-flag-disabled', 'bridge']);
  assert.ok(caps.every((c) => c.available === true));
  const a = B.capabilities();
  const b = B.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(B.capabilities()[0].available, true);
});

test('P2-16. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(B.getStatus(), { enabled: false, wired: false, production: false, mode: 'FOUNDATION' });
  const a = B.getStatus();
  const b = B.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(B.getStatus().mode, 'FOUNDATION');
});

// ---------------------------------------------------------------------------
// robustness + determinism
// ---------------------------------------------------------------------------

test('P2-17. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(B.isBridgeEnabled(), B.isBridgeEnabled());
  assert.deepEqual(B.getComposition(), B.getComposition());
  assert.deepEqual(B.createBridge(), B.createBridge());
  assert.deepEqual(B.health(), B.health());
  assert.deepEqual(B.capabilities(), B.capabilities());
  assert.deepEqual(B.getStatus(), B.getStatus());
});

test('P2-18. never throws under hostile arguments (all exports)', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    for (const k of Object.keys(B)) noThrow(() => B[k](h, h, h), `B.${k}`);
  }
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('P2-19. api-bridge.js imports ONLY ./feature-flag + ./wiring + ./controller and no forbidden surfaces', () => {
  const src = fs.readFileSync(path.join(EDIR, 'api-bridge.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./controller', './runtime-feature-flag', './wiring']);
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"]sqlite3['"]\)/.test(src), 'no sqlite3');
  assert.ok(!/require\(['"][^'"]*(\/routes\/|\/server\b|\/app\b|\/middleware\/)[^'"]*['"]\)/.test(src), 'no routes/server/app/middleware');
  assert.ok(!/\bapp\.use\(|\.listen\(|createServer|express\.Router\(/.test(src), 'no server/mount wiring');
});

test('P2-20. bridge is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
