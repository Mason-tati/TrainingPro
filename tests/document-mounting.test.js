// WP-19 · E6 — Enterprise Route Mounting Readiness tests.
// Verifies the isolated mounting-readiness metadata module: it exposes exactly the six readiness
// functions, delegates the router from ./routes, reports the fixed mount path, returns fresh
// copy-on-read configuration/health/capabilities, is deterministic and never throws, imports ONLY
// ./routes (no Express/server/app/HTTP), mounts nothing (no app.use/listen), and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'mounting.js'));
const routes = require(path.join(EDIR, 'routes.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E6-1. export surface is exact (six readiness functions)', () => {
  assert.deepEqual(Object.keys(M).sort(), [
    'capabilities', 'getConfiguration', 'getMountPath', 'getRouter', 'health', 'isReady',
  ]);
});

test('E6-2. every export is a function', () => {
  for (const k of Object.keys(M)) assert.equal(typeof M[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// getRouter
// ---------------------------------------------------------------------------

test('E6-3. getRouter returns the router imported from ./routes', () => {
  assert.equal(M.getRouter(), routes);
  assert.equal(typeof M.getRouter(), 'function'); // Express router is a function
  assert.ok(Array.isArray(M.getRouter().stack));
});

test('E6-4. getRouter is deterministic (same router reference every call)', () => {
  assert.equal(M.getRouter(), M.getRouter());
});

// ---------------------------------------------------------------------------
// getMountPath
// ---------------------------------------------------------------------------

test('E6-5. getMountPath always returns /api/document-engine', () => {
  assert.equal(M.getMountPath(), '/api/document-engine');
  assert.equal(M.getMountPath(), M.getMountPath());
});

// ---------------------------------------------------------------------------
// getConfiguration
// ---------------------------------------------------------------------------

test('E6-6. getConfiguration returns the expected descriptor shape', () => {
  const c = M.getConfiguration();
  assert.deepEqual(Object.keys(c).sort(), ['middleware', 'mountPath', 'registered', 'router', 'version']);
  assert.equal(c.mountPath, '/api/document-engine');
  assert.equal(c.router, routes);
  assert.deepEqual(c.middleware, []);
  assert.equal(c.registered, false);
  assert.equal(c.version, 1);
});

test('E6-7. getConfiguration returns a FRESH object every call (no shared references)', () => {
  const a = M.getConfiguration();
  const b = M.getConfiguration();
  assert.notEqual(a, b);
  assert.notEqual(a.middleware, b.middleware); // fresh middleware array each call
});

test('E6-8. getConfiguration copy-on-read: mutating a returned copy does not affect later calls', () => {
  const a = M.getConfiguration();
  a.mountPath = 'HACKED';
  a.registered = true;
  a.version = 999;
  a.middleware.push('x');
  const b = M.getConfiguration();
  assert.equal(b.mountPath, '/api/document-engine');
  assert.equal(b.registered, false);
  assert.equal(b.version, 1);
  assert.deepEqual(b.middleware, []);
});

// ---------------------------------------------------------------------------
// isReady
// ---------------------------------------------------------------------------

test('E6-9. isReady always returns true', () => {
  assert.equal(M.isReady(), true);
  assert.equal(M.isReady(), M.isReady());
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E6-10. health returns a deterministic descriptor', () => {
  const h = M.health();
  assert.deepEqual(h, { ready: true, mounted: false, routerAvailable: true });
});

test('E6-11. health is mounted:false (ready to mount, NOT mounted)', () => {
  assert.equal(M.health().mounted, false);
  assert.equal(M.health().ready, true);
});

test('E6-12. health returns a FRESH object every call (copy-on-read)', () => {
  const a = M.health();
  const b = M.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  assert.equal(M.health().ready, true);
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E6-13. capabilities describes router/mountPath/configuration/readiness availability', () => {
  const caps = M.capabilities();
  assert.ok(Array.isArray(caps));
  const names = caps.map((c) => c.name).sort();
  assert.deepEqual(names, ['configuration', 'mountPath', 'readiness', 'router']);
  assert.ok(caps.every((c) => c.available === true));
});

test('E6-14. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = M.capabilities();
  const b = M.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = M.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E6-15. deterministic: identical calls produce deep-equal output', () => {
  assert.deepEqual(M.getConfiguration(), M.getConfiguration());
  assert.deepEqual(M.health(), M.health());
  assert.deepEqual(M.capabilities(), M.capabilities());
  assert.equal(M.getMountPath(), M.getMountPath());
  assert.equal(M.isReady(), M.isReady());
});

test('E6-16. never throws + frozen/hostile args ignored: every export tolerates any argument', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const a of hostile) {
    for (const k of Object.keys(M)) noThrow(() => M[k](a, a, a), `M.${k}`);
  }
  // frozen input is not mutated (functions take no meaningful args, but confirm no throw + stable output)
  const frozen = Object.freeze({ router: 'NO', mountPath: 'NO' });
  assert.equal(M.getMountPath(frozen), '/api/document-engine');
  assert.deepEqual(frozen, { router: 'NO', mountPath: 'NO' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E6-17. mounting.js has exactly ONE import: ./routes', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mounting.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './routes');
});

test('E6-18. mounting.js does NOT import Express / server / app / http', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mounting.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http require');
});

test('E6-19. mounting.js does NOT mount anything (no app.use / listen / createServer / Router())', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mounting.js'), 'utf8');
  assert.ok(!/\bapp\.use\(/.test(src), 'no app.use()');
  assert.ok(!/\.listen\(/.test(src), 'no listen()');
  assert.ok(!/createServer/.test(src), 'no createServer');
  assert.ok(!/express\.Router\(/.test(src), 'creates no router');
});

test('E6-20. mounting is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
