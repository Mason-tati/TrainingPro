// WP-18 · E6 — Enterprise Metadata Engine Foundation tests.
// Exhaustively exercises the validator, normalizer, inheritance, and engine modules:
// creation, update, merge (all strategies), clone, comparison, freeze, remove,
// normalization, validation, inheritance (precedence + blocking), invalid/null/hostile
// inputs, unknown/duplicate/custom fields, immutability, never-throw, determinism, and the
// unwired requirement. Pure in-memory — no DB, no network, no production imports.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MDIR = path.join(ROOT, 'lib', 'document-engine', 'metadata');
const E = require(path.join(MDIR, 'metadata-engine.js'));
const validator = require(path.join(MDIR, 'metadata-validator.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const codes = (r) => r.errors.map((e) => e.code);

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('E6-1. validate: non-object metadata / options coercion', () => {
  assert.equal(validator.validateMetadata(null).valid, false);
  assert.equal(validator.validateMetadata([]).valid, false);
  assert.match(codes(validator.validateMetadata(5)).join('|'), /INVALID_METADATA/);
  // options may be omitted / non-object (coerced to {})
  assert.equal(validator.validateMetadata({ Title: 'ok' }, null).valid, true);
  assert.equal(validator.validateMetadata({ Title: 'ok' }).valid, true);
});

test('E6-2. validate: required fields (missing variants) and present values', () => {
  const r = validator.validateMetadata(
    { Title: '', Tags: [], Owner: null, Description: '   ', Site: 'X' },
    { required: ['Title', 'Tags', 'Owner', 'Description', 'Missing', 'Site'] },
  );
  const requiredErrs = r.errors.filter((e) => e.code === 'REQUIRED').map((e) => e.field).sort();
  assert.deepEqual(requiredErrs, ['Description', 'Missing', 'Owner', 'Tags', 'Title']);
  assert.ok(!requiredErrs.includes('Site')); // Site present → not required-missing
});

test('E6-3. validate: string type, max length (option / field / default), allowed values', () => {
  assert.match(codes(validator.validateMetadata({ Title: 123 })).join('|'), /TYPE/);
  assert.match(codes(validator.validateMetadata({ Title: 'x'.repeat(201) })).join('|'), /MAX_LENGTH/); // field default 200
  assert.match(codes(validator.validateMetadata({ Equipment: 'x'.repeat(201) })).join('|'), /MAX_LENGTH/); // DEFAULT_MAX 200
  assert.equal(validator.validateMetadata({ Title: 'ab' }, { maxLengths: { Title: 5 } }).valid, true);
  assert.match(codes(validator.validateMetadata({ Title: 'abcdef' }, { maxLengths: { Title: 5 } })).join('|'), /MAX_LENGTH/);
  assert.match(codes(validator.validateMetadata({ Classification: 'SECRET' }, { allowedValues: { Classification: ['PUBLIC'] } })).join('|'), /NOT_ALLOWED/);
  assert.equal(validator.validateMetadata({ Classification: 'PUBLIC' }, { allowedValues: { Classification: ['PUBLIC'] } }).valid, true);
});

test('E6-4. validate: array fields', () => {
  assert.equal(validator.validateMetadata({ Tags: ['a', 'b'], Keywords: ['k'] }).valid, true);
  assert.match(codes(validator.validateMetadata({ Tags: 'nope' })).join('|'), /TYPE/); // not an array
  assert.match(codes(validator.validateMetadata({ Tags: ['a', 5] })).join('|'), /TYPE/); // non-string element
});

test('E6-5. validate: dates — pure ISO validation incl. leap years and time ranges', () => {
  const ok = ['2026-01-01', '2026-02-28', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01T10:20', '2026-01-01T10:20:30', '2026-01-01T10:20:30.500Z', '2026-01-01T10:20:30+10:00'];
  for (const d of ok) assert.equal(validator.validateMetadata({ EffectiveDate: d }).valid, true, `valid: ${d}`);
  const bad = [123, 'not-a-date', '2026-13-01', '2026-00-01', '2026-01-00', '2026-04-31', '2023-02-29', '1900-02-29', '2026-01-01T24:00', '2026-01-01T10:60', '2026-01-01T10:10:60'];
  for (const d of bad) assert.equal(validator.validateMetadata({ ReviewDate: d }).valid, false, `invalid: ${d}`);
  // null / undefined date values are skipped (not type errors)
  assert.equal(validator.validateMetadata({ ExpiryDate: null, CreatedDate: undefined }).valid, true);
});

test('E6-6. validate: custom fields (object, keys, scalar/array values, custom validator)', () => {
  assert.equal(validator.validateMetadata({ CustomFields: { a: 'x', n: 1, b: true, arr: [1, 'y', false] } }).valid, true);
  assert.match(codes(validator.validateMetadata({ CustomFields: [] })).join('|'), /INVALID_CUSTOM_FIELD/); // not an object
  assert.match(codes(validator.validateMetadata({ CustomFields: { '   ': 1 } })).join('|'), /INVALID_CUSTOM_FIELD/); // empty key
  assert.match(codes(validator.validateMetadata({ CustomFields: { bad: { nested: 1 } } })).join('|'), /INVALID_CUSTOM_FIELD/); // non-scalar object
  assert.match(codes(validator.validateMetadata({ CustomFields: { fn: () => {} } })).join('|'), /INVALID_CUSTOM_FIELD/); // function
  assert.match(codes(validator.validateMetadata({ CustomFields: { arr: [1, {}] } })).join('|'), /INVALID_CUSTOM_FIELD/); // array with non-scalar
  // custom validator: true ok; false → default message; string → custom message; throw → invalid
  assert.equal(validator.validateMetadata({ CustomFields: { k: 'v' } }, { customFieldValidator: () => true }).valid, true);
  assert.match(codes(validator.validateMetadata({ CustomFields: { k: 'v' } }, { customFieldValidator: () => false })).join('|'), /INVALID_CUSTOM_FIELD/);
  const strMsg = validator.validateMetadata({ CustomFields: { k: 'v' } }, { customFieldValidator: () => 'bespoke error' });
  assert.equal(strMsg.errors[0].message, 'bespoke error');
  assert.equal(validator.validateMetadata({ CustomFields: { k: 'v' } }, { customFieldValidator: () => { throw new Error('boom'); } }).valid, false);
});

test('E6-7. validate: unknown fields, reserved fields, duplicate keys', () => {
  const unk = validator.validateMetadata({ Foo: 1 });
  assert.deepEqual(unk.unknownFields, ['Foo']);
  assert.equal(unk.warnings.some((w) => w.code === 'UNKNOWN_FIELD'), true); // default → warning
  assert.match(codes(validator.validateMetadata({ Foo: 1 }, { allowUnknown: false })).join('|'), /UNKNOWN_FIELD/); // → error
  const res = validator.validateMetadata({ CreatedBy: 'sys' });
  assert.deepEqual(res.reservedFields, ['CreatedBy']);
  assert.equal(res.warnings.some((w) => w.code === 'RESERVED_FIELD'), true); // default → warning
  assert.match(codes(validator.validateMetadata({ CreatedBy: 'sys' }, { allowReserved: false })).join('|'), /RESERVED_FIELD/); // → error
  const dup = validator.validateMetadata({ Owner: 'a', owner: 'b' });
  assert.match(codes(dup).join('|'), /DUPLICATE_KEY/);
  assert.equal(dup.duplicateKeys.includes('Owner') && dup.duplicateKeys.includes('owner'), true);
});

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test('E6-8. normalize: whitespace, line endings, casing, coercion, empty dropping', () => {
  const out = E.normalizeMetadata({
    Title: 5, Description: null, Owner: undefined, Author: '  a\r\n\r\n\r  b\t c  ',
    Site: 'au-01', Language: 'EN', Project: 'keepAsIs',
  });
  assert.equal(out.Title, '5'); // number coerced
  assert.equal('Description' in out, false); // null → '' → dropped
  assert.equal('Owner' in out, false); // undefined → '' → dropped
  assert.equal(out.Author, 'a\nb c'); // CRLF → LF, blank lines collapsed, horizontal ws (incl. tab) collapsed
  assert.equal(out.Site, 'AU-01'); // uppercase field
  assert.equal(out.Language, 'en'); // lowercase field
  assert.equal(out.Project, 'keepAsIs'); // neither → unchanged casing
});

test('E6-9. normalize: arrays — trim, drop empty, dedupe (default) + sort; toggles honoured', () => {
  assert.deepEqual(E.normalizeMetadata({ Tags: [' b ', 'B', 'a', '', 'a'] }).Tags, ['a', 'b']); // trimmed, deduped (ci), sorted
  assert.deepEqual(E.normalizeMetadata({ Keywords: [1, 2] }).Keywords, ['1', '2']); // non-string coerced
  assert.deepEqual(E.normalizeMetadata({ Tags: 'solo' }).Tags, ['solo']); // scalar → single-element array
  assert.equal('Tags' in E.normalizeMetadata({ Tags: null }), false); // null → [] → dropped
  assert.deepEqual(E.normalizeMetadata({ Tags: ['a', 'A'] }, { dedupe: false }).Tags, ['A', 'a']); // dedupe off (still sorted)
  assert.deepEqual(E.normalizeMetadata({ Tags: ['b', 'a'] }, { sortArrays: false }).Tags, ['b', 'a']); // sort off
});

test('E6-10. normalize: dates, custom-field objects, unknown fields, stable ordering, dropEmpty toggle', () => {
  assert.equal(E.normalizeMetadata({ EffectiveDate: ' 2026-1-3 ' }).EffectiveDate, '2026-01-03');
  assert.equal(E.normalizeMetadata({ ReviewDate: 'nonsense' }).ReviewDate, 'nonsense'); // unparseable → trimmed only
  assert.deepEqual(E.normalizeMetadata({ ExpiryDate: 123 }).ExpiryDate, 123); // non-string date → cloned through
  assert.deepEqual(E.normalizeMetadata({ CustomFields: { b: '  x  ', a: 2 } }).CustomFields, { a: 2, b: 'x' }); // keys sorted, string trimmed
  assert.deepEqual(E.normalizeMetadata({ CustomFields: [1] }).CustomFields, [1]); // non-object cloned through
  // unknown fields kept (default), placed after known fields, sorted
  const ord = E.normalizeMetadata({ Zebra: { n: 1 }, Apple: 'a', Title: 't' });
  assert.deepEqual(Object.keys(ord), ['Title', 'Apple', 'Zebra']);
  assert.equal('Apple' in E.normalizeMetadata({ Apple: 'a' }, { dropUnknown: true }), false); // dropUnknown
  // dropEmpty toggle: empties kept when disabled; empty object/array/null covered
  const kept = E.normalizeMetadata({ Title: '', CustomFields: {}, Tags: [] }, { dropEmpty: false });
  assert.deepEqual(kept, { Title: '', Tags: [], CustomFields: {} });
});

// ---------------------------------------------------------------------------
// inheritance
// ---------------------------------------------------------------------------

test('E6-11. inherit: default precedence — own wins, higher sources override lower', () => {
  const r = E.inheritMetadata(
    { Title: 'Own' },
    [{ source: 'site', metadata: { Site: 'AU', Owner: 'SiteOwner', Title: 'SiteTitle' } },
      { source: 'department', metadata: { Owner: 'DeptOwner' } }],
  );
  assert.equal(r.metadata.Title, 'Own'); // own overrides site
  assert.equal(r.metadata.Owner, 'DeptOwner'); // department overrides site
  assert.equal(r.metadata.Site, 'AU'); // only site provides it
  assert.deepEqual(r.resolution, { Site: 'site', Owner: 'department', Title: 'own' });
});

test('E6-12. inherit: custom precedence, blocking, source shapes, deep clone', () => {
  // custom precedence including own (own lowest → template overrides own)
  const p = E.inheritMetadata({ Title: 'Own' }, [{ source: 'template', metadata: { Title: 'Tmpl' } }], { precedence: ['own', 'template'] });
  assert.equal(p.metadata.Title, 'Tmpl');
  // custom precedence WITHOUT own (own appended as highest)
  const q = E.inheritMetadata({ Owner: 'Me' }, [{ source: 'site', metadata: { Owner: 'S', Site: 'AU' } }], { precedence: ['site'] });
  assert.equal(q.metadata.Owner, 'Me');
  assert.equal(q.metadata.Site, 'AU');
  // blocking: Owner never inherited (only own may supply); non-string block entries ignored
  const b = E.inheritMetadata({}, [{ source: 'department', metadata: { Owner: 'Dept', Site: 'X' } }], { blocked: ['Owner', 123] });
  assert.equal('Owner' in b.metadata, false); // blocked and own lacks it → absent
  assert.equal(b.metadata.Site, 'X');
  // sources as a map
  const m = E.inheritMetadata({}, { site: { Site: 'AU' }, department: { Department: 'ENG' } });
  assert.deepEqual(m.metadata, { Site: 'AU', Department: 'ENG' });
  // junk sources and null sources tolerated
  const j = E.inheritMetadata({ Title: 'T' }, [{ nope: 1 }, 'str', null, { source: 'site', metadata: { Site: 'AU' } }]);
  assert.deepEqual(j.metadata, { Site: 'AU', Title: 'T' });
  assert.deepEqual(E.inheritMetadata({ Title: 'T' }, null).metadata, { Title: 'T' });
  // deep clone: inherited arrays/objects are copies, not references
  const parentMeta = { Tags: ['a'], CustomFields: { x: 1 } };
  const inh = E.inheritMetadata({}, [{ source: 'parent', metadata: parentMeta }]);
  assert.notEqual(inh.metadata.Tags, parentMeta.Tags);
  assert.deepEqual(inh.metadata.Tags, ['a']);
});

// ---------------------------------------------------------------------------
// engine: clone / freeze / create / merge / update / remove / compare
// ---------------------------------------------------------------------------

test('E6-13. clone + freeze: deep copies; frozen outputs; non-object coerced', () => {
  const src = { a: { b: 1 }, arr: [1, 2] };
  const clone = E.cloneMetadata(src);
  assert.notEqual(clone.a, src.a);
  assert.deepEqual(clone, src);
  assert.deepEqual(E.cloneMetadata(5), {}); // non-object → {}
  const frozen = E.freezeMetadata({ a: { b: 1 }, arr: [3], s: 'x' });
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.a) && Object.isFrozen(frozen.arr));
});

test('E6-14. create: deep clone, optional normalize + freeze', () => {
  const input = { Title: '  Hi  ' };
  assert.deepEqual(E.createMetadata(input), { Title: '  Hi  ' }); // clone, no normalize
  assert.deepEqual(E.createMetadata(input, { normalize: true }), { Title: 'Hi' });
  assert.ok(Object.isFrozen(E.createMetadata(input, { freeze: true })));
  assert.deepEqual(E.createMetadata(5), {}); // non-object input
  assert.equal(input.Title, '  Hi  '); // input not mutated
});

test('E6-15. merge: strategies (overwrite/keepExisting), arrays (replace/append/union), objects (replace/merge)', () => {
  assert.deepEqual(E.mergeMetadata({ A: 1 }, { B: 2 }), { A: 1, B: 2 }); // new key
  assert.deepEqual(E.mergeMetadata({ A: 1 }, { A: 2 }), { A: 2 }); // scalar overwrite (default)
  assert.deepEqual(E.mergeMetadata({ A: 1 }, { A: 2 }, { strategy: 'keepExisting' }), { A: 1 });
  assert.deepEqual(E.mergeMetadata({ T: ['a'] }, { T: ['b'] }).T, ['b']); // array replace overwrite
  assert.deepEqual(E.mergeMetadata({ T: ['a'] }, { T: ['b'] }, { strategy: 'keepExisting' }).T, ['a']); // array replace keep
  assert.deepEqual(E.mergeMetadata({ T: ['a'] }, { T: ['b'] }, { arrays: 'append' }).T, ['a', 'b']);
  assert.deepEqual(E.mergeMetadata({ T: ['a', 'b'] }, { T: ['b', 'c'] }, { arrays: 'union' }).T, ['a', 'b', 'c']);
  assert.deepEqual(E.mergeMetadata({ O: { a: 1 } }, { O: { b: 2 } }, { objects: 'merge' }).O, { a: 1, b: 2 });
  assert.deepEqual(E.mergeMetadata({ O: { a: 1 } }, { O: { b: 2 } }).O, { b: 2 }); // object replace overwrite
  assert.deepEqual(E.mergeMetadata({ O: { a: 1 } }, { O: { b: 2 } }, { strategy: 'keepExisting' }).O, { a: 1 });
  assert.deepEqual(E.mergeMetadata(5, { A: 1 }), { A: 1 }); // non-object base
  // union keyOf: objects and null elements
  assert.deepEqual(E.mergeMetadata({ L: [{ a: 1 }, null] }, { L: [{ a: 1 }, { a: 2 }, null] }, { arrays: 'union' }).L, [{ a: 1 }, null, { a: 2 }]);
});

test('E6-16. update: merges patch, optional normalize + freeze, no mutation', () => {
  const existing = { Title: 'Old', Tags: ['a'] };
  const updated = E.updateMetadata(existing, { Title: 'New', Tags: ['b'] }, { mergeOptions: { arrays: 'append' } });
  assert.deepEqual(updated, { Title: 'New', Tags: ['a', 'b'] });
  assert.deepEqual(existing, { Title: 'Old', Tags: ['a'] }); // unchanged
  assert.deepEqual(E.updateMetadata({ Title: '  x  ' }, {}, { normalize: true }), { Title: 'x' });
  assert.ok(Object.isFrozen(E.updateMetadata({ A: 1 }, { B: 2 }, { freeze: true })));
});

test('E6-17. remove: string / array / nullish fields, non-string entries ignored', () => {
  assert.deepEqual(E.removeMetadata({ A: 1, B: 2 }, 'A'), { B: 2 }); // single string
  assert.deepEqual(E.removeMetadata({ A: 1, B: 2, C: 3 }, ['A', 'C', 7]), { B: 2 }); // array; non-string 7 ignored
  assert.deepEqual(E.removeMetadata({ A: 1 }, undefined), { A: 1 }); // nullish → no-op
  assert.deepEqual(E.removeMetadata({ A: 1 }, null), { A: 1 });
  const src = { A: 1 }; E.removeMetadata(src, 'A'); assert.deepEqual(src, { A: 1 }); // no mutation
});

test('E6-18. compare: added / removed / modified / unchanged with deep equality', () => {
  const a = { Title: 'a', Owner: 'x', Arr: [1], Obj: { a: 1 }, Same: 1 };
  const b = { Title: 'b', Site: 's', Arr: [1], Obj: { a: 2 }, Same: 1 };
  const d = E.compareMetadata(a, b);
  assert.deepEqual(d.added, ['Site']);
  assert.deepEqual(d.removed, ['Owner']);
  assert.deepEqual(d.modified.sort(), ['Obj', 'Title']);
  assert.deepEqual(d.unchanged.sort(), ['Arr', 'Same']);
  assert.deepEqual(E.compareMetadata(5, 6), { added: [], removed: [], modified: [], unchanged: [] }); // non-objects
});

test('E6-19. compare: deepEqual covers array/object/scalar mismatches and lengths', () => {
  const diff = (av, bv) => E.compareMetadata({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true); // array length differs
  assert.equal(diff([1], [2]), true); // array element differs
  assert.equal(diff([1], { x: 1 }), true); // array vs object
  assert.equal(diff({ x: 1 }, [1]), true); // object vs array
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true); // object key count differs
  assert.equal(diff({ a: 1 }, { b: 1 }), true); // object key names differ (hasOwnProperty)
  assert.equal(diff({ a: 1 }, { a: 2 }), true); // object value differs
  assert.equal(diff(1, '1'), true); // scalar type differs (final false path)
  assert.equal(E.compareMetadata({ F: [1, { x: 1 }] }, { F: [1, { x: 1 }] }).unchanged.length, 1); // deep equal arrays/objects
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E6-20. never throws: every engine + validator method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { CustomFields: [1] }, { Tags: 7 }, { EffectiveDate: {} }];
  for (const a of hostile) {
    noThrow(() => E.validateMetadata(a, a), 'validateMetadata');
    noThrow(() => E.normalizeMetadata(a, a), 'normalizeMetadata');
    noThrow(() => E.cloneMetadata(a), 'cloneMetadata');
    noThrow(() => E.freezeMetadata(a), 'freezeMetadata');
    noThrow(() => E.createMetadata(a, a), 'createMetadata');
    noThrow(() => E.updateMetadata(a, a, a), 'updateMetadata');
    noThrow(() => E.mergeMetadata(a, a, a), 'mergeMetadata');
    noThrow(() => E.removeMetadata(a, a), 'removeMetadata');
    noThrow(() => E.compareMetadata(a, a), 'compareMetadata');
    noThrow(() => E.inheritMetadata(a, a, a), 'inheritMetadata');
  }
});

test('E6-21. immutability: caller objects are never mutated', () => {
  const meta = Object.freeze({ Title: '  hi  ', Tags: Object.freeze(['b', 'a']), CustomFields: Object.freeze({ x: 1 }) });
  const snapshot = JSON.parse(JSON.stringify(meta));
  noThrow(() => E.normalizeMetadata(meta), 'normalize frozen');
  noThrow(() => E.mergeMetadata(meta, { Title: 'z' }), 'merge frozen');
  noThrow(() => E.updateMetadata(meta, { Owner: 'o' }), 'update frozen');
  noThrow(() => E.inheritMetadata(meta, [{ source: 'site', metadata: meta }]), 'inherit frozen');
  noThrow(() => E.removeMetadata(meta, 'Title'), 'remove frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(meta)), snapshot, 'input unchanged');
});

test('E6-22. deterministic: identical inputs produce identical output', () => {
  const input = { Tags: ['b', 'a', 'a'], Site: 'au', Title: '  T  ', CustomFields: { b: 2, a: 1 } };
  assert.deepEqual(E.normalizeMetadata(input), E.normalizeMetadata(input));
  const src = [{ source: 'site', metadata: { Site: 'AU', Owner: 'S' } }, { source: 'department', metadata: { Owner: 'D' } }];
  assert.deepEqual(E.inheritMetadata({ Title: 'T' }, src), E.inheritMetadata({ Title: 'T' }, src));
  assert.deepEqual(E.compareMetadata(input, input), E.compareMetadata(input, input));
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E6-23. metadata modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/|\/numbering\/)/;
  // The four E6 runtime modules. The directory may contain additional metadata modules
  // (e.g. the WP-18 E7 policy engine); we assert only the E6 runtime modules here.
  const E6_MODULES = ['metadata-engine.js', 'metadata-inheritance.js', 'metadata-normalizer.js', 'metadata-validator.js'];
  for (const f of E6_MODULES) {
    const full = path.join(MDIR, f);
    assert.ok(fs.existsSync(full), `${f} exists`);
    const src = fs.readFileSync(full, 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\/metadata-(validator|normalizer|inheritance)\1\)/.test(r), `${f} only requires sibling metadata modules (found ${r})`);
    }
  }
});

test('E6-24. metadata engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
