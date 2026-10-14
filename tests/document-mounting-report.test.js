// WP-19 · E7 — Enterprise Production Mounting Safety Report tests.
// Verifies the isolated readiness-reporting module: it exposes exactly the five reporting
// functions, produces the expected fresh report/summary/checklist/health/capabilities, is
// deterministic and copy-on-read, never throws, imports ONLY ./mounting (no Express/server/app/
// http/routes), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'mounting-report.js'));
const mounting = require(path.join(EDIR, 'mounting.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E7-1. export surface is exact (five reporting functions)', () => {
  assert.deepEqual(Object.keys(R).sort(), [
    'capabilities', 'generateReport', 'getChecklist', 'getSummary', 'health',
  ]);
});

test('E7-2. every export is a function', () => {
  for (const k of Object.keys(R)) assert.equal(typeof R[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// generateReport
// ---------------------------------------------------------------------------

test('E7-3. generateReport returns the expected readiness report', () => {
  const rep = R.generateReport();
  assert.deepEqual(Object.keys(rep).sort(), [
    'configurationReady', 'mountPath', 'mounted', 'productionWired', 'ready', 'routerReady', 'version',
  ]);
  assert.equal(rep.ready, true);
  assert.equal(rep.mounted, false);
  assert.equal(rep.mountPath, '/api/document-engine');
  assert.equal(rep.routerReady, true);
  assert.equal(rep.configurationReady, true);
  assert.equal(rep.productionWired, false);
  assert.equal(rep.version, 1);
});

test('E7-4. generateReport is derived from ./mounting (consistent with mounting metadata)', () => {
  const rep = R.generateReport();
  assert.equal(rep.mountPath, mounting.getMountPath());
  assert.equal(rep.mounted, mounting.health().mounted);
  assert.equal(rep.routerReady, mounting.health().routerAvailable);
  assert.equal(rep.productionWired, mounting.getConfiguration().registered);
  assert.equal(rep.version, mounting.getConfiguration().version);
  assert.equal(rep.ready, mounting.isReady());
});

test('E7-5. generateReport returns a FRESH object every call (copy-on-read)', () => {
  const a = R.generateReport();
  const b = R.generateReport();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.mountPath = 'HACKED';
  assert.equal(R.generateReport().ready, true);
  assert.equal(R.generateReport().mountPath, '/api/document-engine');
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

test('E7-6. getSummary returns the expected summary', () => {
  const s = R.getSummary();
  assert.deepEqual(s, { status: 'READY', production: 'NOT_MOUNTED', safe: true });
});

test('E7-7. getSummary returns a FRESH object every call (copy-on-read)', () => {
  const a = R.getSummary();
  const b = R.getSummary();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.status = 'HACKED';
  a.safe = false;
  assert.equal(R.getSummary().status, 'READY');
  assert.equal(R.getSummary().safe, true);
});

// ---------------------------------------------------------------------------
// getChecklist
// ---------------------------------------------------------------------------

test('E7-8. getChecklist returns the expected five-item checklist', () => {
  const c = R.getChecklist();
  assert.ok(Array.isArray(c));
  assert.equal(c.length, 5);
  assert.deepEqual(c.map((x) => x.item), [
    'Router available', 'Mount path defined', 'Configuration available', 'Not mounted', 'Safe for future integration',
  ]);
  assert.ok(c.every((x) => x.ok === true));
});

test('E7-9. getChecklist returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = R.getChecklist();
  const b = R.getChecklist();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ item: 'HACK', ok: true });
  a[0].ok = false;
  const c = R.getChecklist();
  assert.equal(c.length, 5);
  assert.ok(c.every((x) => x.ok === true));
});

// ---------------------------------------------------------------------------
// health + capabilities
// ---------------------------------------------------------------------------

test('E7-10. health returns a deterministic descriptor', () => {
  assert.deepEqual(R.health(), { ready: true, mounted: false, reportAvailable: true });
});

test('E7-11. health returns a FRESH object every call (copy-on-read)', () => {
  const a = R.health();
  const b = R.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  assert.equal(R.health().ready, true);
});

test('E7-12. capabilities describes report/summary/checklist/readiness availability', () => {
  const caps = R.capabilities();
  assert.ok(Array.isArray(caps));
  assert.deepEqual(caps.map((c) => c.name).sort(), ['checklist', 'readiness', 'report', 'summary']);
  assert.ok(caps.every((c) => c.available === true));
});

test('E7-13. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = R.capabilities();
  const b = R.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = R.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E7-14. deterministic: identical calls produce deep-equal output', () => {
  assert.deepEqual(R.generateReport(), R.generateReport());
  assert.deepEqual(R.getSummary(), R.getSummary());
  assert.deepEqual(R.getChecklist(), R.getChecklist());
  assert.deepEqual(R.health(), R.health());
  assert.deepEqual(R.capabilities(), R.capabilities());
});

test('E7-15. never throws + frozen/hostile args ignored: every export tolerates any argument', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const a of hostile) {
    for (const k of Object.keys(R)) noThrow(() => R[k](a, a, a), `R.${k}`);
  }
});

test('E7-16. frozen input is not mutated (functions take no meaningful args)', () => {
  const frozen = Object.freeze({ ready: 'NO', mountPath: 'NO' });
  assert.deepEqual(R.generateReport(frozen), R.generateReport());
  assert.deepEqual(frozen, { ready: 'NO', mountPath: 'NO' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E7-17. mounting-report.js has exactly ONE import: ./mounting', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mounting-report.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './mounting');
});

test('E7-18. mounting-report.js does NOT import Express / server / app / http / routes directly', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mounting-report.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http require');
  assert.ok(!/require\(['"]\.\/routes['"]\)/.test(src), 'does not import ./routes directly');
});

test('E7-19. mounting-report.js does NOT mount anything (no app.use / listen / createServer / Router())', () => {
  const src = fs.readFileSync(path.join(EDIR, 'mounting-report.js'), 'utf8');
  assert.ok(!/\bapp\.use\(/.test(src), 'no app.use()');
  assert.ok(!/\.listen\(/.test(src), 'no listen()');
  assert.ok(!/createServer/.test(src), 'no createServer');
  assert.ok(!/express\.Router\(/.test(src), 'creates no router');
});

test('E7-20. report module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
