// WP-19 · E9 — Enterprise Final Pre-Wiring Readiness Gate tests.
// Verifies the isolated readiness-gate module: it exposes exactly the five gate functions,
// produces the expected fresh readiness/gate/summary/health/capabilities, is deterministic and
// copy-on-read, never throws, imports ONLY ./integration-contract (no Express/server/app/http/
// routes/mounting/mounting-report), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const G = require(path.join(EDIR, 'readiness-gate.js'));
const contract = require(path.join(EDIR, 'integration-contract.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E9-1. export surface is exact (five gate functions)', () => {
  assert.deepEqual(Object.keys(G).sort(), [
    'capabilities', 'getGate', 'getReadiness', 'getSummary', 'health',
  ]);
});

test('E9-2. every export is a function', () => {
  for (const k of Object.keys(G)) assert.equal(typeof G[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// getReadiness
// ---------------------------------------------------------------------------

test('E9-3. getReadiness returns the expected readiness verdict', () => {
  const r = G.getReadiness();
  assert.deepEqual(Object.keys(r).sort(), [
    'gatePassed', 'integrationReady', 'mounted', 'productionReady', 'ready', 'version', 'wiringRequired',
  ]);
  assert.equal(r.ready, true);
  assert.equal(r.productionReady, false);
  assert.equal(r.gatePassed, true);
  assert.equal(r.mounted, false);
  assert.equal(r.integrationReady, true);
  assert.equal(r.wiringRequired, true);
  assert.equal(r.version, 1);
});

test('E9-4. getReadiness is derived from ./integration-contract (consistent with the contract)', () => {
  const r = G.getReadiness();
  const c = contract.getContract();
  assert.equal(r.ready, c.ready);
  assert.equal(r.productionReady, c.productionReady);
  assert.equal(r.mounted, c.mounted);
  assert.equal(r.version, c.version);
});

test('E9-5. getReadiness returns a FRESH object every call (copy-on-read)', () => {
  const a = G.getReadiness();
  const b = G.getReadiness();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.wiringRequired = false;
  a.version = 999;
  assert.equal(G.getReadiness().ready, true);
  assert.equal(G.getReadiness().wiringRequired, true);
  assert.equal(G.getReadiness().version, 1);
});

// ---------------------------------------------------------------------------
// getGate
// ---------------------------------------------------------------------------

test('E9-6. getGate returns the expected gate descriptor', () => {
  assert.deepEqual(G.getGate(), {
    name: 'Enterprise Document Engine', state: 'READY_FOR_WIRING', productionIntegrated: false, safe: true,
  });
});

test('E9-7. getGate returns a FRESH object every call (copy-on-read)', () => {
  const a = G.getGate();
  const b = G.getGate();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.state = 'HACKED';
  a.safe = false;
  assert.equal(G.getGate().state, 'READY_FOR_WIRING');
  assert.equal(G.getGate().safe, true);
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

test('E9-8. getSummary returns the expected summary', () => {
  assert.deepEqual(G.getSummary(), { status: 'READY', nextPhase: 'PRODUCTION_WIRING', safe: true });
});

test('E9-9. getSummary returns a FRESH object every call (copy-on-read)', () => {
  const a = G.getSummary();
  const b = G.getSummary();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.status = 'HACKED';
  a.nextPhase = 'NONE';
  assert.equal(G.getSummary().status, 'READY');
  assert.equal(G.getSummary().nextPhase, 'PRODUCTION_WIRING');
});

// ---------------------------------------------------------------------------
// health + capabilities
// ---------------------------------------------------------------------------

test('E9-10. health returns a deterministic descriptor', () => {
  assert.deepEqual(G.health(), { ready: true, gateAvailable: true, productionIntegrated: false });
});

test('E9-11. health returns a FRESH object every call (copy-on-read)', () => {
  const a = G.health();
  const b = G.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  assert.equal(G.health().ready, true);
});

test('E9-12. capabilities describes the gate/contract/report/safety availability', () => {
  const caps = G.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'Readiness Gate', 'Integration Contract', 'Mounting Report', 'Production Safety',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E9-13. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = G.capabilities();
  const b = G.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = G.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E9-14. deterministic: identical calls produce deep-equal output', () => {
  assert.deepEqual(G.getReadiness(), G.getReadiness());
  assert.deepEqual(G.getGate(), G.getGate());
  assert.deepEqual(G.getSummary(), G.getSummary());
  assert.deepEqual(G.health(), G.health());
  assert.deepEqual(G.capabilities(), G.capabilities());
});

test('E9-15. never throws + frozen/hostile args ignored: every export tolerates any argument', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const a of hostile) {
    for (const k of Object.keys(G)) noThrow(() => G[k](a, a, a), `G.${k}`);
  }
});

test('E9-16. frozen input is not mutated (functions take no meaningful args)', () => {
  const frozen = Object.freeze({ ready: 'NO', version: 'NO' });
  assert.deepEqual(G.getReadiness(frozen), G.getReadiness());
  assert.deepEqual(frozen, { ready: 'NO', version: 'NO' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E9-17. readiness-gate.js has exactly ONE import: ./integration-contract', () => {
  const src = fs.readFileSync(path.join(EDIR, 'readiness-gate.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './integration-contract');
});

test('E9-18. does NOT import Express / server / app / http / routes / mounting / mounting-report', () => {
  const src = fs.readFileSync(path.join(EDIR, 'readiness-gate.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http require');
  assert.ok(!/require\(['"]\.\/routes['"]\)/.test(src), 'no direct ./routes import');
  assert.ok(!/require\(['"]\.\/mounting['"]\)/.test(src), 'no direct ./mounting import');
  assert.ok(!/require\(['"]\.\/mounting-report['"]\)/.test(src), 'no direct ./mounting-report import');
});

test('E9-19. does NOT mount anything (no app.use / listen / createServer / Router())', () => {
  const src = fs.readFileSync(path.join(EDIR, 'readiness-gate.js'), 'utf8');
  assert.ok(!/\bapp\.use\(/.test(src), 'no app.use()');
  assert.ok(!/\.listen\(/.test(src), 'no listen()');
  assert.ok(!/createServer/.test(src), 'no createServer');
  assert.ok(!/express\.Router\(/.test(src), 'creates no router');
});

test('E9-20. gate module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
