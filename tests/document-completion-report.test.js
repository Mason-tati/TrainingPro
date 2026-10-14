// WP-19 · E10 — Enterprise Final Engine Completion Report tests.
// Verifies the isolated completion-report module: it exposes exactly the five completion
// functions, produces the expected fresh completion/summary/milestones/health/capabilities, is
// deterministic and copy-on-read, never throws, imports ONLY ./readiness-gate (no Express/server/
// app/http/routes/controller/adapters/document-service/mounting/mounting-report/integration-contract),
// and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'completion-report.js'));
const gate = require(path.join(EDIR, 'readiness-gate.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E10-1. export surface is exact (five completion functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'getCompletion', 'getMilestones', 'getSummary', 'health',
  ]);
});

test('E10-2. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// getCompletion
// ---------------------------------------------------------------------------

test('E10-3. getCompletion returns the expected completion verdict', () => {
  const c = C.getCompletion();
  assert.deepEqual(Object.keys(c).sort(), [
    'foundationComplete', 'nextPhase', 'productionIntegrated', 'readyForIntegration', 'version',
  ]);
  assert.equal(c.foundationComplete, true);
  assert.equal(c.productionIntegrated, false);
  assert.equal(c.readyForIntegration, true);
  assert.equal(c.nextPhase, 'WP-20');
  assert.equal(c.version, 1);
});

test('E10-4. getCompletion is derived from ./readiness-gate (consistent with the gate)', () => {
  const c = C.getCompletion();
  const r = gate.getReadiness();
  assert.equal(c.foundationComplete, r.ready);
  assert.equal(c.productionIntegrated, r.mounted);
  assert.equal(c.readyForIntegration, r.gatePassed);
  assert.equal(c.version, r.version);
});

test('E10-5. getCompletion returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getCompletion();
  const b = C.getCompletion();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.foundationComplete = false;
  a.nextPhase = 'HACKED';
  a.version = 999;
  assert.equal(C.getCompletion().foundationComplete, true);
  assert.equal(C.getCompletion().nextPhase, 'WP-20');
  assert.equal(C.getCompletion().version, 1);
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

test('E10-6. getSummary returns the expected summary', () => {
  assert.deepEqual(C.getSummary(), { status: 'FOUNDATION_COMPLETE', production: 'NOT_INTEGRATED', safe: true });
});

test('E10-7. getSummary returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getSummary();
  const b = C.getSummary();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.status = 'HACKED';
  a.safe = false;
  assert.equal(C.getSummary().status, 'FOUNDATION_COMPLETE');
  assert.equal(C.getSummary().safe, true);
});

// ---------------------------------------------------------------------------
// getMilestones
// ---------------------------------------------------------------------------

test('E10-8. getMilestones returns the expected four milestones', () => {
  const m = C.getMilestones();
  assert.ok(Array.isArray(m));
  assert.equal(m.length, 4);
  assert.deepEqual(m.map((x) => x.milestone), [
    'WP-17 Complete', 'WP-18 Complete', 'WP-19 Complete', 'Ready For WP-20',
  ]);
  assert.ok(m.every((x) => x.complete === true));
});

test('E10-9. getMilestones returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = C.getMilestones();
  const b = C.getMilestones();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ milestone: 'HACK', complete: false });
  a[0].complete = false;
  const c = C.getMilestones();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.complete === true));
});

// ---------------------------------------------------------------------------
// health + capabilities
// ---------------------------------------------------------------------------

test('E10-10. health returns a deterministic descriptor', () => {
  assert.deepEqual(C.health(), { ready: true, foundationComplete: true, productionIntegrated: false });
});

test('E10-11. health returns a FRESH object every call (copy-on-read)', () => {
  const a = C.health();
  const b = C.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  assert.equal(C.health().ready, true);
});

test('E10-12. capabilities describes completion/gate/contract/production availability', () => {
  const caps = C.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 4);
  assert.deepEqual(caps.map((c) => c.name), [
    'Completion Report', 'Readiness Gate', 'Integration Contract', 'Production Readiness',
  ]);
  assert.ok(caps.every((c) => c.available === true));
});

test('E10-13. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = C.capabilities();
  const b = C.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = C.capabilities();
  assert.equal(c.length, 4);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E10-14. deterministic: identical calls produce deep-equal output', () => {
  assert.deepEqual(C.getCompletion(), C.getCompletion());
  assert.deepEqual(C.getSummary(), C.getSummary());
  assert.deepEqual(C.getMilestones(), C.getMilestones());
  assert.deepEqual(C.health(), C.health());
  assert.deepEqual(C.capabilities(), C.capabilities());
});

test('E10-15. never throws + frozen/hostile args ignored: every export tolerates any argument', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const a of hostile) {
    for (const k of Object.keys(C)) noThrow(() => C[k](a, a, a), `C.${k}`);
  }
});

test('E10-16. frozen input is not mutated (functions take no meaningful args)', () => {
  const frozen = Object.freeze({ foundationComplete: 'NO', version: 'NO' });
  assert.deepEqual(C.getCompletion(frozen), C.getCompletion());
  assert.deepEqual(frozen, { foundationComplete: 'NO', version: 'NO' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E10-17. completion-report.js has exactly ONE import: ./readiness-gate', () => {
  const src = fs.readFileSync(path.join(EDIR, 'completion-report.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './readiness-gate');
});

test('E10-18. does NOT import Express / server / app / http / other siblings directly', () => {
  const src = fs.readFileSync(path.join(EDIR, 'completion-report.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http require');
  for (const sib of ['routes', 'controller', 'api-adapter', 'repository-adapter', 'document-service', 'mounting', 'mounting-report', 'integration-contract']) {
    assert.ok(!new RegExp(`require\\(['"]\\./${sib}['"]\\)`).test(src), `no direct ./${sib} import`);
  }
});

test('E10-19. does NOT mount anything (no app.use / listen / createServer / Router())', () => {
  const src = fs.readFileSync(path.join(EDIR, 'completion-report.js'), 'utf8');
  assert.ok(!/\bapp\.use\(/.test(src), 'no app.use()');
  assert.ok(!/\.listen\(/.test(src), 'no listen()');
  assert.ok(!/createServer/.test(src), 'no createServer');
  assert.ok(!/express\.Router\(/.test(src), 'creates no router');
});

test('E10-20. completion module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
