// WP-22 · Phase 1 — Enterprise Document Engine Runtime Feature Flag tests.
// Verifies the production-ready env-driven flag: exact export surface; DEFAULT OFF when the
// variable is missing; enabling values true/1 (case-insensitive, trimmed); disabling values
// false/0/empty/unexpected; configured detection; status/health/capabilities/configuration; fresh
// objects (copy-on-read); determinism; never throws; imports NOTHING; is the only process.env
// reader; and is unwired (no production consumer imports lib/document-engine).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const FLAG = require(path.join(EDIR, 'runtime-feature-flag.js'));
const VAR = 'DOCUMENT_ENGINE_ENABLED';

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// Run `fn` with the env var set to `value` (or deleted when value === undefined), restoring the
// previous value afterwards so tests never leak environment state.
function withEnv(value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, VAR);
  const prev = process.env[VAR];
  try {
    if (value === undefined) delete process.env[VAR]; else process.env[VAR] = value;
    return fn();
  } finally {
    if (had) process.env[VAR] = prev; else delete process.env[VAR];
  }
}

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('W1-1. export surface is exact (six functions)', () => {
  assert.deepEqual(Object.keys(FLAG).sort(), [
    'capabilities', 'getConfiguration', 'getStatus', 'health', 'isConfigured', 'isEnabled',
  ]);
});

test('W1-2. every export is a function', () => {
  for (const k of Object.keys(FLAG)) assert.equal(typeof FLAG[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// default OFF (missing variable)
// ---------------------------------------------------------------------------

test('W1-3. missing variable → disabled and not configured (DEFAULT OFF)', () => {
  withEnv(undefined, () => {
    assert.equal(FLAG.isEnabled(), false);
    assert.equal(FLAG.isConfigured(), false);
  });
});

// ---------------------------------------------------------------------------
// enabling values
// ---------------------------------------------------------------------------

test('W1-4. "true" enables', () => {
  withEnv('true', () => { assert.equal(FLAG.isEnabled(), true); assert.equal(FLAG.isConfigured(), true); });
});

test('W1-5. "1" enables', () => {
  withEnv('1', () => { assert.equal(FLAG.isEnabled(), true); });
});

test('W1-6. "TRUE" (uppercase) enables (case-insensitive)', () => {
  withEnv('TRUE', () => assert.equal(FLAG.isEnabled(), true));
});

test('W1-7. "True" (mixed case) enables', () => {
  withEnv('True', () => assert.equal(FLAG.isEnabled(), true));
});

test('W1-8. "  true  " (surrounding whitespace) enables (trimmed)', () => {
  withEnv('  true  ', () => assert.equal(FLAG.isEnabled(), true));
});

// ---------------------------------------------------------------------------
// disabling values
// ---------------------------------------------------------------------------

test('W1-9. "false" is configured but disabled', () => {
  withEnv('false', () => { assert.equal(FLAG.isEnabled(), false); assert.equal(FLAG.isConfigured(), true); });
});

test('W1-10. "0" is configured but disabled', () => {
  withEnv('0', () => { assert.equal(FLAG.isEnabled(), false); assert.equal(FLAG.isConfigured(), true); });
});

test('W1-11. "FALSE" (uppercase) is disabled', () => {
  withEnv('FALSE', () => assert.equal(FLAG.isEnabled(), false));
});

test('W1-12. empty string is configured but disabled', () => {
  withEnv('', () => { assert.equal(FLAG.isEnabled(), false); assert.equal(FLAG.isConfigured(), true); });
});

test('W1-13. unexpected values ("yes", "2", "maybe", "on") are configured but disabled', () => {
  for (const v of ['yes', '2', 'maybe', 'on', 'enabled', 'truthy']) {
    withEnv(v, () => { assert.equal(FLAG.isEnabled(), false, `${v} disabled`); assert.equal(FLAG.isConfigured(), true); });
  }
});

// ---------------------------------------------------------------------------
// getStatus / health / capabilities / getConfiguration
// ---------------------------------------------------------------------------

test('W1-14. getStatus reflects enabled/configured and is a fresh copy', () => {
  withEnv(undefined, () => {
    assert.deepEqual(FLAG.getStatus(), { enabled: false, configured: false, production: false, mode: 'FOUNDATION' });
  });
  withEnv('true', () => {
    assert.deepEqual(FLAG.getStatus(), { enabled: true, configured: true, production: false, mode: 'FOUNDATION' });
  });
  const a = FLAG.getStatus();
  const b = FLAG.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(FLAG.getStatus().mode, 'FOUNDATION');
});

test('W1-15. health reflects enabled/configured and is a fresh copy', () => {
  withEnv('1', () => {
    assert.deepEqual(FLAG.health(), { ready: true, enabled: true, configured: true, safe: true });
  });
  withEnv(undefined, () => {
    assert.deepEqual(FLAG.health(), { ready: true, enabled: false, configured: false, safe: true });
  });
  const a = FLAG.health();
  const b = FLAG.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(FLAG.health().ready, true);
});

test('W1-16. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = FLAG.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'runtime-feature-flag', 'environment-configuration', 'foundation-mode', 'production-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = FLAG.capabilities();
  const b = FLAG.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(FLAG.capabilities()[0].available, true);
});

test('W1-17. getConfiguration reports the variable name, default false, and current state (fresh copy)', () => {
  withEnv(undefined, () => {
    assert.deepEqual(FLAG.getConfiguration(), { variable: 'DOCUMENT_ENGINE_ENABLED', configured: false, enabled: false, default: false });
  });
  withEnv('true', () => {
    assert.deepEqual(FLAG.getConfiguration(), { variable: 'DOCUMENT_ENGINE_ENABLED', configured: true, enabled: true, default: false });
  });
  const a = FLAG.getConfiguration();
  const b = FLAG.getConfiguration();
  assert.notEqual(a, b);
  a.variable = 'HACKED';
  assert.equal(FLAG.getConfiguration().variable, 'DOCUMENT_ENGINE_ENABLED');
});

// ---------------------------------------------------------------------------
// determinism + never throws
// ---------------------------------------------------------------------------

test('W1-18. deterministic for a fixed environment; live-reads env with no caching', () => {
  withEnv('true', () => {
    assert.equal(FLAG.isEnabled(), FLAG.isEnabled());
    assert.equal(FLAG.isEnabled(), true);
  });
  // no caching: a later environment change is reflected immediately
  withEnv('false', () => assert.equal(FLAG.isEnabled(), false));
  withEnv('1', () => assert.equal(FLAG.isEnabled(), true));
});

test('W1-19. never throws under hostile arguments and across env states', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), () => {}];
  for (const state of [undefined, 'true', 'false', '1', '0', '', 'weird']) {
    withEnv(state, () => {
      for (const h of hostile) {
        for (const k of Object.keys(FLAG)) noThrow(() => FLAG[k](h, h, h), `FLAG.${k}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// import discipline (ZERO imports) + single process.env reader + unwired
// ---------------------------------------------------------------------------

test('W1-20. imports NOTHING, is the sole process.env reader in document-engine, and is unwired', () => {
  const src = fs.readFileSync(path.join(EDIR, 'runtime-feature-flag.js'), 'utf8');
  // zero imports
  assert.equal((src.match(/require\(/g) || []).length, 0, 'no require() at all');
  // reads exactly the one env variable, and no other module in document-engine touches process.env
  assert.ok(/process\.env\[VARIABLE\]|process\.env\.DOCUMENT_ENGINE_ENABLED/.test(src), 'reads DOCUMENT_ENGINE_ENABLED');
  const engineFiles = fs.readdirSync(EDIR).filter((f) => f.endsWith('.js') && f !== 'runtime-feature-flag.js');
  for (const f of engineFiles) {
    assert.ok(!/process\.env/.test(fs.readFileSync(path.join(EDIR, f), 'utf8')), `${f} must not read process.env`);
  }
  // unwired: no production consumer imports lib/document-engine
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
