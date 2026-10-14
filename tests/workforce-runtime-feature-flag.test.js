// EWP-01a — Workforce Foundation Framework — runtime-feature-flag tests.
// The single source of truth for WORKFORCE_ENGINE_ENABLED; default OFF, explicit-enable only.
require('./helpers/network-guard');
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const flag = require(path.join(__dirname, '..', 'lib', 'workforce', 'runtime-feature-flag.js'));
const VAR = 'WORKFORCE_ENGINE_ENABLED';

afterEach(() => { delete process.env[VAR]; });

test('EWP-FF-1. disabled by default when unset', () => {
  delete process.env[VAR];
  assert.equal(flag.isEnabled(), false);
  assert.equal(flag.isConfigured(), false);
  assert.equal(flag.rawValue(), undefined);
});

test('EWP-FF-2. enabling values: true / 1 / case / whitespace', () => {
  for (const v of ['true', 'TRUE', ' true ', '1', ' 1 ']) {
    process.env[VAR] = v;
    assert.equal(flag.isEnabled(), true, `"${v}" enables`);
  }
});

test('EWP-FF-3. non-enabling values stay OFF but count as configured', () => {
  for (const v of ['false', '0', '', 'yes', 'enabled']) {
    process.env[VAR] = v;
    assert.equal(flag.isEnabled(), false, `"${v}" stays off`);
    assert.equal(flag.isConfigured(), true, `"${v}" is configured`);
  }
});

test('EWP-FF-4. getStatus / health return fresh deterministic objects', () => {
  process.env[VAR] = 'true';
  const s = flag.getStatus();
  assert.deepEqual(s, { variable: VAR, enabled: true, configured: true, mounted: false, mode: 'FOUNDATION' });
  const h = flag.health();
  assert.deepEqual(h, { ready: true, enabled: true, configured: true, safe: true });
  assert.notEqual(flag.getStatus(), s, 'fresh object each call');
  assert.equal(flag.VARIABLE, VAR);
});
