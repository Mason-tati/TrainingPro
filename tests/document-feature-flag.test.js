// WP-20 · E1 — Enterprise Document Engine Feature Flag tests.
// Verifies the isolated feature-flag module: it exposes exactly the six flag functions, defaults
// OFF, enable()/disable() never persist any state, produces the expected fresh status/health/
// capabilities, is deterministic and copy-on-read, never throws, imports NOTHING (zero requires,
// no express/server/process.env/fs/database), and is unwired (no production consumer imports it).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const F = require(path.join(EDIR, 'feature-flag.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('E1-1. export surface is exact (six flag functions)', () => {
  assert.deepEqual(Object.keys(F).sort(), [
    'capabilities', 'disable', 'enable', 'getStatus', 'health', 'isEnabled',
  ]);
});

test('E1-2. every export is a function', () => {
  for (const k of Object.keys(F)) assert.equal(typeof F[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// isEnabled — always OFF
// ---------------------------------------------------------------------------

test('E1-3. isEnabled always returns false', () => {
  assert.equal(F.isEnabled(), false);
  assert.equal(F.isEnabled(), F.isEnabled());
});

// ---------------------------------------------------------------------------
// enable / disable — pure descriptors, never persist
// ---------------------------------------------------------------------------

test('E1-4. enable returns { enabled: true }', () => {
  assert.deepEqual(F.enable(), { enabled: true });
});

test('E1-5. enable does NOT persist (isEnabled stays false afterwards)', () => {
  F.enable();
  F.enable();
  F.enable();
  assert.equal(F.isEnabled(), false);
  assert.equal(F.getStatus().enabled, false);
  assert.equal(F.health().enabled, false);
});

test('E1-6. disable returns { enabled: false }', () => {
  assert.deepEqual(F.disable(), { enabled: false });
});

test('E1-7. disable does NOT persist (isEnabled stays false afterwards)', () => {
  F.disable();
  assert.equal(F.isEnabled(), false);
});

test('E1-8. enable then isEnabled interleaving never flips the flag', () => {
  for (let i = 0; i < 5; i += 1) {
    F.enable();
    assert.equal(F.isEnabled(), false);
  }
});

test('E1-9. enable/disable return FRESH objects every call (copy-on-read)', () => {
  const a = F.enable();
  const b = F.enable();
  assert.notEqual(a, b);
  a.enabled = 'HACKED';
  assert.deepEqual(F.enable(), { enabled: true });
  const c = F.disable();
  const d = F.disable();
  assert.notEqual(c, d);
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

test('E1-10. getStatus returns the expected status', () => {
  assert.deepEqual(F.getStatus(), { enabled: false, mode: 'FOUNDATION', production: false });
});

test('E1-11. getStatus returns a FRESH object every call (copy-on-read)', () => {
  const a = F.getStatus();
  const b = F.getStatus();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.enabled = true;
  a.mode = 'HACKED';
  a.production = true;
  assert.deepEqual(F.getStatus(), { enabled: false, mode: 'FOUNDATION', production: false });
});

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

test('E1-12. health returns the expected descriptor', () => {
  assert.deepEqual(F.health(), { ready: true, enabled: false, safe: true });
});

test('E1-13. health returns a FRESH object every call (copy-on-read)', () => {
  const a = F.health();
  const b = F.health();
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
  a.ready = false;
  a.enabled = true;
  assert.deepEqual(F.health(), { ready: true, enabled: false, safe: true });
});

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

test('E1-14. capabilities returns the expected three entries', () => {
  const caps = F.capabilities();
  assert.ok(Array.isArray(caps));
  assert.equal(caps.length, 3);
  assert.deepEqual(caps.map((c) => c.name), ['feature-flag', 'foundation-mode', 'production-disabled']);
  assert.ok(caps.every((c) => c.available === true));
});

test('E1-15. capabilities returns a FRESH array + fresh entries every call (copy-on-read)', () => {
  const a = F.capabilities();
  const b = F.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a, b);
  a.push({ name: 'HACK', available: true });
  a[0].available = false;
  const c = F.capabilities();
  assert.equal(c.length, 3);
  assert.ok(c.every((x) => x.available === true));
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E1-16. deterministic: identical calls produce deep-equal output', () => {
  assert.equal(F.isEnabled(), F.isEnabled());
  assert.deepEqual(F.enable(), F.enable());
  assert.deepEqual(F.disable(), F.disable());
  assert.deepEqual(F.getStatus(), F.getStatus());
  assert.deepEqual(F.health(), F.health());
  assert.deepEqual(F.capabilities(), F.capabilities());
});

test('E1-17. never throws + frozen/hostile args ignored: every export tolerates any argument', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1])];
  for (const a of hostile) {
    for (const k of Object.keys(F)) noThrow(() => F[k](a, a, a), `F.${k}`);
  }
});

test('E1-18. frozen input is not mutated + flag stays OFF regardless of args', () => {
  const frozen = Object.freeze({ enabled: 'FORCE_ON' });
  assert.equal(F.isEnabled(frozen), false);
  assert.deepEqual(F.enable(frozen), { enabled: true }); // still just a descriptor
  assert.equal(F.isEnabled(frozen), false);
  assert.deepEqual(frozen, { enabled: 'FORCE_ON' });
});

// ---------------------------------------------------------------------------
// import discipline (ZERO imports) + unwired
// ---------------------------------------------------------------------------

test('E1-19. feature-flag.js imports NOTHING and touches no runtime surfaces', () => {
  const src = fs.readFileSync(path.join(EDIR, 'feature-flag.js'), 'utf8');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 0, 'zero requires');
  assert.ok(!/require\(/.test(src), 'no require() at all');
  assert.ok(!/process\.env/.test(src), 'no process.env');
  assert.ok(!/\bprocess\b/.test(src), 'no process access');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"]fs['"]\)/.test(src), 'no fs');
  assert.ok(!/(database\/db|\.db\b|sqlite)/.test(src), 'no database');
  assert.ok(!/\bapp\.use\(|\.listen\(|createServer|express\.Router\(/.test(src), 'no server/mount wiring');
});

test('E1-20. feature-flag is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
