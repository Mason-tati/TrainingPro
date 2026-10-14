// WP-18 · E5 — Enterprise Document Number Generator Foundation tests.
// Exhaustively exercises the template engine, the in-memory sequence manager, and the
// document number generator: normal generation, every token, custom separators, padding,
// parsing, validation, normalization, preview, independent sequences, reset/peek, invalid
// templates/tokens, duplicate tokens, never-throw, input immutability, deterministic output,
// and the unwired requirement. Pure in-memory — no DB, no network, no production imports.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NDIR = path.join(ROOT, 'lib', 'document-engine', 'numbering');
const DocumentNumberGenerator = require(path.join(NDIR, 'document-number-generator.js'));
const SequenceManager = require(path.join(NDIR, 'sequence-manager.js'));
const tmpl = require(path.join(NDIR, 'numbering-template.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// numbering-template.js
// ---------------------------------------------------------------------------

test('E5-1. template engine: supported tokens are frozen and recognised', () => {
  assert.ok(Object.isFrozen(tmpl.TOKENS));
  assert.deepEqual(tmpl.TOKENS, ['SITE', 'DEPARTMENT', 'TYPE', 'YEAR', 'MONTH', 'DAY', 'SEQUENCE', 'REVISION']);
  assert.equal(tmpl.isSupportedToken('SITE'), true);
  assert.equal(tmpl.isSupportedToken('NOPE'), false);
  assert.equal(tmpl.isSupportedToken(123), false);
});

test('E5-2. parseTemplate: valid templates, literals, and all tokens', () => {
  const ok = tmpl.parseTemplate('SOP-{YEAR}-{SEQUENCE}');
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.tokens, ['YEAR', 'SEQUENCE']);
  assert.deepEqual(ok.parts, [
    { type: 'literal', value: 'SOP-' },
    { type: 'token', value: 'YEAR' },
    { type: 'literal', value: '-' },
    { type: 'token', value: 'SEQUENCE' },
  ]);
  // token first (no leading literal), then a trailing literal (flush both paths)
  const lead = tmpl.parseTemplate('{SEQUENCE}-END');
  assert.equal(lead.valid, true);
  assert.deepEqual(lead.parts, [{ type: 'token', value: 'SEQUENCE' }, { type: 'literal', value: '-END' }]);
  // every supported token once
  const all = tmpl.parseTemplate('{SITE}{DEPARTMENT}{TYPE}{YEAR}{MONTH}{DAY}{SEQUENCE}{REVISION}');
  assert.equal(all.valid, true);
  assert.equal(all.tokens.length, 8);
});

test('E5-3. parseTemplate: rejects malformed templates, invalid + duplicate tokens, missing SEQUENCE', () => {
  assert.equal(tmpl.parseTemplate('').valid, false);
  assert.equal(tmpl.parseTemplate(null).valid, false);
  assert.match(tmpl.parseTemplate('SOP-{SEQUENCE').errors.join('|'), /unterminated/);
  assert.match(tmpl.parseTemplate('{}{SEQUENCE}').errors.join('|'), /empty token/);
  assert.match(tmpl.parseTemplate('{FOO}-{SEQUENCE}').errors.join('|'), /invalid token/);
  assert.match(tmpl.parseTemplate('{SEQUENCE}-{SEQUENCE}').errors.join('|'), /duplicate token/);
  assert.match(tmpl.parseTemplate('a}b-{SEQUENCE}').errors.join('|'), /unexpected/);
  assert.match(tmpl.parseTemplate('DOC-{YEAR}').errors.join('|'), /must contain the \{SEQUENCE\}/);
});

test('E5-4. renderParts: literals + tokens, missing values → empty, non-object values tolerated', () => {
  const parts = [{ type: 'literal', value: 'X-' }, { type: 'token', value: 'YEAR' }, { type: 'token', value: 'SEQUENCE' }];
  assert.equal(tmpl.renderParts(parts, { YEAR: '2026', SEQUENCE: '000001' }), 'X-2026000001');
  assert.equal(tmpl.renderParts(parts, { SEQUENCE: '1' }), 'X-1'); // YEAR missing → ''
  assert.equal(tmpl.renderParts(parts, null), 'X-'); // non-object values → treated as {}
});

// ---------------------------------------------------------------------------
// sequence-manager.js
// ---------------------------------------------------------------------------

test('E5-5. sequence manager: next / peek / independent namespaces', () => {
  const sm = new SequenceManager();
  assert.equal(sm.peekSequence('SOP'), 1); // preview before any issue
  assert.equal(sm.getNextSequence('SOP'), 1);
  assert.equal(sm.getNextSequence('SOP'), 2);
  assert.equal(sm.peekSequence('SOP'), 3); // peek does not advance
  assert.equal(sm.getNextSequence('WI'), 1); // independent namespace
  assert.equal(sm.getNextSequence('FORM'), 1);
  assert.equal(sm.getNextSequence('SOP'), 3); // SOP unaffected by WI/FORM
});

test('E5-6. sequence manager: reset / set / increment and their return values', () => {
  const sm = new SequenceManager({ start: 0, step: 1 });
  sm.getNextSequence('A'); sm.getNextSequence('A');
  assert.equal(sm.resetSequence('A'), 0);
  assert.equal(sm.getNextSequence('A'), 1); // reset → issue restarts at 1
  assert.equal(sm.setSequence('A', 100), 100);
  assert.equal(sm.getNextSequence('A'), 101); // next issued = value + step
  assert.equal(sm.increment('A'), 102); // default step
  assert.equal(sm.increment('A', 10), 112); // custom amount
});

test('E5-7. sequence manager: options + argument validation', () => {
  // option coercion (invalid → defaults; valid → honoured)
  assert.equal(new SequenceManager(5).getNextSequence('N'), 1); // non-object options
  assert.equal(new SequenceManager({ start: -1, step: 0 }).getNextSequence('N'), 1); // invalid → start 0 / step 1
  assert.equal(new SequenceManager({ start: 1000, step: 5 }).getNextSequence('N'), 1005); // valid start+step
  const sm = new SequenceManager();
  assert.throws(() => sm.getNextSequence(''), /non-empty string/);
  assert.throws(() => sm.getNextSequence(42), /non-empty string/);
  assert.throws(() => sm.setSequence('N', -1), /non-negative integer/);
  assert.throws(() => sm.setSequence('N', 1.5), /non-negative integer/);
  assert.throws(() => sm.increment('N', 0), /positive integer/);
  assert.throws(() => sm.increment('N', -3), /positive integer/);
});

// ---------------------------------------------------------------------------
// document-number-generator.js — generation
// ---------------------------------------------------------------------------

test('E5-8. generate: normal generation, multiple templates, custom separators, padding', () => {
  assert.equal(new DocumentNumberGenerator({ template: 'DOC-{SEQUENCE}' }).generate({}).number, 'DOC-000001');
  assert.equal(new DocumentNumberGenerator({ template: 'WI-{SEQUENCE}' }).generate({}).number, 'WI-000001');
  assert.equal(new DocumentNumberGenerator({ template: 'SOP-{YEAR}-{SEQUENCE}' }).generate({ year: 2026 }).number, 'SOP-2026-000001');
  assert.equal(new DocumentNumberGenerator({ template: 'TRN-{SITE}-{SEQUENCE}' }).generate({ site: 'AU' }).number, 'TRN-AU-000001');
  // custom separators are just template literals — any character works
  assert.equal(new DocumentNumberGenerator({ template: 'FORM_{TYPE}_{SEQUENCE}' }).generate({ type: 'TH' }).number, 'FORM_TH_000001');
  assert.equal(new DocumentNumberGenerator({ template: '{SITE}/{DEPARTMENT}/{TYPE}/{SEQUENCE}' }).generate({ site: 'A', department: 'B', type: 'C' }).number, 'A/B/C/000001');
  // padding / minimum width
  assert.equal(new DocumentNumberGenerator({ template: 'P-{SEQUENCE}', padWidth: 3 }).generate({}).number, 'P-001');
  assert.equal(new DocumentNumberGenerator({ template: 'P-{SEQUENCE}', minWidth: 8, padWidth: 6 }).generate({}).number, 'P-00000001');
  // prefix + suffix wrapping
  assert.equal(new DocumentNumberGenerator({ template: '{SEQUENCE}', prefix: 'PRE-', suffix: '-END' }).generate({}).number, 'PRE-000001-END');
});

test('E5-9. generate: every supported token, revision padding (numeric vs alpha), date padding', () => {
  const g = new DocumentNumberGenerator({ template: '{SITE}-{DEPARTMENT}-{TYPE}-{YEAR}-{MONTH}-{DAY}-{SEQUENCE}-{REVISION}', revisionWidth: 3 });
  assert.equal(g.generate({ site: 'AU', department: 'TH', type: 'SOP', year: 2026, month: 3, day: 9, revision: 2 }).number,
    'AU-TH-SOP-2026-03-09-000001-002'); // month/day zero-padded to 2, revision to 3
  const alpha = new DocumentNumberGenerator({ template: 'R-{SEQUENCE}-{REVISION}' });
  assert.equal(alpha.generate({ revision: 'A' }).number, 'R-000001-A'); // non-numeric revision passes through
});

test('E5-10. generate: sequence context resolution — null / empty / alternate keys are handled', () => {
  const g = new DocumentNumberGenerator({ template: 'DOC-{SEQUENCE}', strict: false });
  // null, '' → treated as absent; alternate key (dept) resolves; used purely to exercise resolution
  const r = g.generate({ site: null, department: '', dept: 'ENG', type: 'T', month: 5, day: 12, rev: 'A' });
  assert.equal(r.ok, true);
  assert.equal(r.number, 'DOC-000001');
});

test('E5-11. generate + preview: preview never consumes; generate advances', () => {
  const g = new DocumentNumberGenerator({ template: 'SOP-{SEQUENCE}' });
  assert.equal(g.preview({}).number, 'SOP-000001');
  assert.equal(g.preview({}).number, 'SOP-000001'); // idempotent
  assert.equal(g.generate({}).number, 'SOP-000001');
  assert.equal(g.generate({}).number, 'SOP-000002');
  assert.equal(g.preview({}).number, 'SOP-000003');
});

test('E5-12. generate: strict rejects missing token values; non-strict renders them empty', () => {
  const strict = new DocumentNumberGenerator({ template: 'SOP-{YEAR}-{SEQUENCE}' });
  const miss = strict.generate({});
  assert.equal(miss.ok, false);
  assert.equal(miss.number, null);
  assert.match(miss.errors.join('|'), /missing value for \{YEAR\}/);
  const loose = new DocumentNumberGenerator({ template: 'SOP-{YEAR}-{SEQUENCE}', strict: false });
  assert.equal(loose.generate({}).number, 'SOP--000001'); // empty YEAR, sequence still consumed
});

test('E5-13. generate: invalid template fails safely (never throws)', () => {
  const bad = new DocumentNumberGenerator({ template: '{FOO}-{SEQUENCE}' });
  const r = bad.generate({});
  assert.equal(r.ok, false);
  assert.equal(r.number, null);
  assert.match(r.errors.join('|'), /invalid token/);
});

test('E5-14. generate: injected sequence manager (independent namespaces) + partial managers ignored', () => {
  const sm = new SequenceManager();
  const sop = new DocumentNumberGenerator({ template: 'SOP-{SEQUENCE}', sequenceManager: sm, namespace: 'SOP' });
  const wi = new DocumentNumberGenerator({ template: 'WI-{SEQUENCE}', sequenceManager: sm, namespace: 'WI' });
  assert.equal(sop.generate({}).number, 'SOP-000001');
  assert.equal(wi.generate({}).number, 'WI-000001'); // independent counter on the shared manager
  assert.equal(sop.generate({}).number, 'SOP-000002');
  // partial/invalid managers are ignored → an internal manager is used instead
  const p1 = new DocumentNumberGenerator({ template: 'A-{SEQUENCE}', sequenceManager: { getNextSequence() {} } }); // no peek
  const p2 = new DocumentNumberGenerator({ template: 'B-{SEQUENCE}', sequenceManager: { peekSequence() {} } }); // no next
  assert.equal(p1.generate({}).number, 'A-000001');
  assert.equal(p2.generate({}).number, 'B-000001');
  // custom start/step honoured on the internal manager
  assert.equal(new DocumentNumberGenerator({ template: 'C-{SEQUENCE}', start: 1000, step: 5 }).generate({}).number, 'C-001005');
  // blank namespace falls back to the default namespace
  assert.equal(new DocumentNumberGenerator({ template: 'D-{SEQUENCE}', namespace: '   ' }).generate({}).number, 'D-000001');
});

test('E5-15. generate/preview: a throwing sequence manager is caught (never throws)', () => {
  const throwing = { getNextSequence() { throw new Error('seq-boom'); }, peekSequence() { throw new Error('peek-boom'); } };
  const g = new DocumentNumberGenerator({ template: 'X-{SEQUENCE}', sequenceManager: throwing });
  const a = g.generate({});
  assert.equal(a.ok, false);
  assert.match(a.errors.join('|'), /seq-boom/);
  const b = g.preview({});
  assert.equal(b.ok, false);
  assert.match(b.errors.join('|'), /peek-boom/);
  // a non-Error throw falls back to a generic message
  const nullThrow = { getNextSequence() { throw null; }, peekSequence() { throw null; } };
  const g2 = new DocumentNumberGenerator({ template: 'Y-{SEQUENCE}', sequenceManager: nullThrow });
  assert.match(g2.generate({}).errors.join('|'), /sequence error/);
});

// ---------------------------------------------------------------------------
// document-number-generator.js — validate / parse / normalize
// ---------------------------------------------------------------------------

test('E5-16. validate: own template by default, or a supplied template', () => {
  const g = new DocumentNumberGenerator({ template: 'SOP-{SEQUENCE}' });
  assert.deepEqual(g.validate(), { valid: true, errors: [] });
  assert.equal(g.validate('{SEQUENCE}').valid, true);
  const bad = g.validate('{SEQUENCE}-{SEQUENCE}');
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join('|'), /duplicate/);
  assert.equal(new DocumentNumberGenerator({ template: '{FOO}-{SEQUENCE}' }).validate().valid, false);
});

test('E5-17. parse: round-trips a formatted number back into tokens', () => {
  const g = new DocumentNumberGenerator({ template: 'SOP-{YEAR}-{SEQUENCE}' });
  const r = g.parse('SOP-2026-000015');
  assert.equal(r.ok, true);
  assert.deepEqual(r.tokens, { YEAR: '2026', SEQUENCE: '000015' });
  assert.equal(r.sequence, 15);
  assert.equal(g.parse('not-a-match').ok, false);
  assert.equal(g.parse(null).ok, false);
  // prefix/suffix are stripped before matching; mismatched prefix/suffix are left intact (no match)
  const pg = new DocumentNumberGenerator({ template: '{SEQUENCE}', prefix: 'PRE-', suffix: '-END' });
  assert.equal(pg.parse('PRE-000009-END').sequence, 9);
  assert.equal(pg.parse('XXX000009-END').ok, false); // prefix does not start-match
  assert.equal(pg.parse('PRE-000009').sequence, 9); // suffix absent is tolerated (endsWith false)
  // invalid template → parse fails safely
  assert.equal(new DocumentNumberGenerator({ template: '{FOO}-{SEQUENCE}' }).parse('x').ok, false);
});

test('E5-18. normalize: trims, upper-cases, strips spaces, re-pads sequence; best-effort otherwise', () => {
  const g = new DocumentNumberGenerator({ template: 'SOP-{YEAR}-{SEQUENCE}' });
  assert.equal(g.normalize('  sop-2026-3 '), 'SOP-2026-000003');
  assert.equal(g.normalize('nonsense'), 'NONSENSE'); // unparseable → cleaned best-effort
  assert.equal(g.normalize(null), ''); // null → empty
  const pg = new DocumentNumberGenerator({ template: '{SEQUENCE}', prefix: 'PRE-', suffix: '-END' });
  assert.equal(pg.normalize('pre-7-end'), 'PRE-000007-END'); // input case-folded, then re-rendered
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E5-19. never throws: public methods tolerate hostile inputs', () => {
  const configs = [undefined, null, 5, {}, { template: 123 }, { template: '{SEQUENCE}' }, { template: '{BROKEN' }];
  for (const cfg of configs) {
    let g;
    noThrow(() => { g = new DocumentNumberGenerator(cfg); }, `constructor(${JSON.stringify(cfg)})`);
    for (const input of [undefined, null, 5, 'x', {}, [], { year: 2026 }]) {
      noThrow(() => g.generate(input), 'generate');
      noThrow(() => g.preview(input), 'preview');
      noThrow(() => g.parse(input), 'parse');
      noThrow(() => g.normalize(input), 'normalize');
      noThrow(() => g.validate(input), 'validate');
    }
  }
});

test('E5-20. immutability: config and context objects are never mutated', () => {
  const config = Object.freeze({ template: 'SOP-{YEAR}-{SEQUENCE}', prefix: 'P-', padWidth: 6 });
  const configSnapshot = JSON.parse(JSON.stringify(config));
  let g;
  noThrow(() => { g = new DocumentNumberGenerator(config); }, 'frozen config');
  const context = Object.freeze({ year: 2026, site: 'AU' });
  const contextSnapshot = JSON.parse(JSON.stringify(context));
  noThrow(() => g.generate(context), 'generate(frozen context)');
  noThrow(() => g.preview(context), 'preview(frozen context)');
  assert.deepEqual(JSON.parse(JSON.stringify(config)), configSnapshot, 'config unchanged');
  assert.deepEqual(JSON.parse(JSON.stringify(context)), contextSnapshot, 'context unchanged');
});

test('E5-21. deterministic: identical inputs + state produce identical output', () => {
  const make = () => new DocumentNumberGenerator({ template: 'SOP-{YEAR}-{SEQUENCE}' });
  assert.equal(make().generate({ year: 2026 }).number, make().generate({ year: 2026 }).number);
  const g = make();
  assert.equal(g.preview({ year: 2026 }).number, g.preview({ year: 2026 }).number); // preview stable
  // driving the same sequence forward yields the same series every time
  const seriesA = [1, 2, 3].map(() => make().generate({ year: 2026 }).number);
  const gg = make();
  const seriesB = [gg.generate({ year: 2026 }).number, gg.generate({ year: 2026 }).number, gg.generate({ year: 2026 }).number];
  assert.deepEqual(seriesA, ['SOP-2026-000001', 'SOP-2026-000001', 'SOP-2026-000001']);
  assert.deepEqual(seriesB, ['SOP-2026-000001', 'SOP-2026-000002', 'SOP-2026-000003']);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E5-22. numbering modules import nothing from production (db/express/routes/services/repositories/server/logger)', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const files = fs.readdirSync(NDIR).filter((f) => f.endsWith('.js'));
  assert.deepEqual(files.sort(), ['document-number-generator.js', 'numbering-template.js', 'sequence-manager.js']);
  for (const f of files) {
    const src = fs.readFileSync(path.join(NDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\/(sequence-manager|numbering-template)\1\)/.test(r), `${f} only requires sibling numbering modules (found ${r})`);
    }
  }
});

test('E5-23. numbering is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
