// Protected-value / number-unit validation (lib/value-guard.js).
const { test } = require('node:test');
const assert = require('node:assert');
const vg = require('../../lib/value-guard');

test('identical text has no missing values', () => {
  const s = 'Isolate at 0 kPa. Max speed 4.5 m/s. Verify within 2 minutes. Pass 80%. Use CAT 745.';
  const r = vg.compareValues(s, s);
  assert.equal(r.ok, true);
  assert.equal(r.criticalCount, 0);
});

test('a plain-language rewrite that keeps all values passes', () => {
  const src = 'Isolate at 0 kPa. Max belt speed 4.5 m/s. Verify within 2 minutes. Pass mark 80%. Use CAT 745. Load 35 t. Torque 120 Nm. Below 80°C.';
  const good = 'Lock out at 0 kPa. The belt must not exceed 4.5 m/s. Check within 2 minutes. You must score 80%. Use CAT745. Do not load over 35 t. Tighten to 120 Nm. Keep under 80°C.';
  assert.equal(vg.compareValues(src, good).ok, true);
});

test('dropped / changed critical values are flagged', () => {
  const src = 'Isolate at 0 kPa. Max belt speed 4.5 m/s. Pass 80%.';
  const bad = 'Isolate the machine. Max belt speed 5 m/s. Pass 80%.';
  const r = vg.compareValues(src, bad);
  assert.equal(r.ok, false);
  const values = r.critical.map((x) => x.value);
  assert.ok(values.some((v) => /0\s?kPa/i.test(v)), 'flags dropped 0 kPa');
  assert.ok(values.some((v) => /4\.5\s?m\/s/i.test(v)), 'flags changed 4.5 m/s');
});

test('ordinary prose numbers do not become false model codes', () => {
  const src = 'Do not load more than 35 t and mark 80% on the sheet.';
  const r = vg.compareValues(src, src);
  // "load 35" / "mark 80" must NOT be treated as model codes (uppercase-only rule)
  assert.equal(r.ok, true);
});

test('bare-number differences are minor, not failing', () => {
  const src = 'Complete 15 checks and 40 items in the list';
  const out = 'Complete the checks and items in the list'; // bare numbers dropped
  const r = vg.compareValues(src, out);
  assert.equal(r.ok, true, 'bare numbers do not fail the check');
  assert.ok(r.minorCount >= 2, 'but are reported as minor');
});

test('documentText flattens sections, tables and risk', () => {
  const data = {
    title: 'T', sections: [
      { heading: 'Limits', body: 'Max 4.5 m/s', table: { headers: ['A'], rows: [['600 kPa']] }, risk: { hazard: 'x', score: 20 } },
    ],
  };
  const t = vg.documentText(data);
  assert.match(t, /4\.5 m\/s/);
  assert.match(t, /600 kPa/);
  assert.match(t, /20/);
});
