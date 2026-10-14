// WP-19 · E8 — Enterprise Pre-Mount Integration Contract tests.
// Verifies the isolated integration-contract module: it exposes exactly the five contract
// functions, produces the expected fresh contract/requirements/summary/health/capabilities, is
// deterministic and copy-on-read, never throws, imports ONLY ./mounting-report (no Express/server/
// app/http/routes/mounting), and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'integration-contract.js'));
const report = require(path.join(EDIR, 'mounting-report.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E8-1. export surface is exact (five contract functions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'capabilities', 'getContract', 'getRequirements', 'getSummary', 'health',
  ]);
});

test('E8-2. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// getContract
// ---------------------------------------------------------------------------

test('E8-3. getContract returns the expected integration contract', () => {
  const c = C.getContract();
  assert.deepEqual(Object.keys(c).sort(), [
    'mounted', 'productionReady', 'ready', 'requiresAudit', 'requiresAuthentication',
    'requiresAuthorization', 'requiresExpressMount', 'requiresLogging', 'requiresValidation', 'version',
  ]);
  assert.equal(c.ready, true);
  assert.equal(c.productionReady, false);
  assert.equal(c.mounted, false);
  assert.equal(c.requiresExpressMount, true);
  assert.equal(c.requiresAuthentication, true);
  assert.equal(c.requiresAuthorization, true);
  assert.equal(c.requiresValidation, true);
  assert.equal(c.requiresAudit, true);
  assert.equal(c.requiresLogging, true);
  assert.equal(c.version, 1);
});

test('E8-4. getContract is derived from ./mounting-report (consistent with the report)', () => {
  const c = C.getContract();
  const rep = report.generateReport();
  assert.equal(c.ready, rep.ready);
  assert.equal(c.mounted, rep.mounted);
  assert.equal(c.productionReady, rep.productionWired);
  assert.equal(c.version, rep.version);
});

test('E8-5. getContract returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getContract();
  const b = C.getContract();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.requiresAuthentication = false;
  a.version = 999;
  assert.equal(C.getContract().ready, true);
  assert.equal(C.getContract().requiresAuthentication, true);
  assert.equal(C.getContract().version, 1);
});

// ---------------------------------------------------------------------------
// getRequirements
// ---------------------------------------------------------------------------

test('E8-6. getRequirements returns the expected six requirements', () => {
  const r = C.getRequirements();
  assert.ok(Array.isArray(r));
  assert.equal(r.length, 6);
  assert.deepEqual(r.map((x) => x.name), [
    'Express mounting', 'Authentication', 'Authorization', 'Validation', 'Audit logging', 'Production registration',
  ]);
  assert.ok(r.every((x) => x.required === true));
});

test('E8-7. getRequirements returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = C.getRequirements();
  const b = C.getRequirements();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', required: false });
  a[0].required = false;
  const c = C.getRequirements();
  assert.equal(c.length, 6);
  assert.ok(c.every((x) => x.required === true));
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------

test('E8-8. getSummary returns the expected summary', () => {
  assert.deepEqual(C.getSummary(), { status: 'READY', production: 'NOT_INTEGRATED', safe: true });
});

test('E8-9. getSummary returns a FRESH object every call (copy-on-read)', () => {
  const a = C.getSummary();
  const b = C.getSummary();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.status = 'HACKED';
  a.safe = false;
  assert.equal(C.getSummary().status, 'READY');
  assert.equal(C.getSummary().safe, true);
});

// ---------------------------------------------------------------------------
// health + capabilities
// ---------------------------------------------------------------------------

test('E8-10. health returns a deterministic descriptor', () => {
  assert.deepEqual(C.health(), { ready: true, contractAvailable: true, productionIntegrated: false });
});

test('E8-11. health returns a FRESH object every call (copy-on-read)', () => {
  const a = C.health();
  const b = C.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  assert.equal(C.health().ready, true);
});

test('E8-12. capabilities describes contract/requirements/summary/readiness availability', () => {
  const caps = C.capabilities();
  assert.ok(Array.isArray(caps));
  assert.deepEqual(caps.map((c) => c.name).sort(), ['contract', 'readiness', 'requirements', 'summary']);
  assert.ok(caps.every((c) => c.available === true));
});

test('E8-13. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
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

test('E8-14. deterministic: identical calls produce deep-equal output', () => {
  assert.deepEqual(C.getContract(), C.getContract());
  assert.deepEqual(C.getRequirements(), C.getRequirements());
  assert.deepEqual(C.getSummary(), C.getSummary());
  assert.deepEqual(C.health(), C.health());
  assert.deepEqual(C.capabilities(), C.capabilities());
});

test('E8-15. never throws + frozen/hostile args ignored: every export tolerates any argument', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const a of hostile) {
    for (const k of Object.keys(C)) noThrow(() => C[k](a, a, a), `C.${k}`);
  }
});

test('E8-16. frozen input is not mutated (functions take no meaningful args)', () => {
  const frozen = Object.freeze({ ready: 'NO', version: 'NO' });
  assert.deepEqual(C.getContract(frozen), C.getContract());
  assert.deepEqual(frozen, { ready: 'NO', version: 'NO' });
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('E8-17. integration-contract.js has exactly ONE import: ./mounting-report', () => {
  const src = fs.readFileSync(path.join(EDIR, 'integration-contract.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  const target = requires[0].replace(/require\((['"])(.*?)\1\)/, '$2');
  assert.equal(target, './mounting-report');
});

test('E8-18. does NOT import Express / server / app / http / routes / mounting directly', () => {
  const src = fs.readFileSync(path.join(EDIR, 'integration-contract.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/require\(['"][^'"]*(server|app|http)[^'"]*['"]\)/.test(src), 'no server/app/http require');
  assert.ok(!/require\(['"]\.\/routes['"]\)/.test(src), 'no direct ./routes import');
  assert.ok(!/require\(['"]\.\/mounting['"]\)/.test(src), 'no direct ./mounting import');
});

test('E8-19. does NOT mount anything (no app.use / listen / createServer / Router())', () => {
  const src = fs.readFileSync(path.join(EDIR, 'integration-contract.js'), 'utf8');
  assert.ok(!/\bapp\.use\(/.test(src), 'no app.use()');
  assert.ok(!/\.listen\(/.test(src), 'no listen()');
  assert.ok(!/createServer/.test(src), 'no createServer');
  assert.ok(!/express\.Router\(/.test(src), 'creates no router');
});

test('E8-20. contract module is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
