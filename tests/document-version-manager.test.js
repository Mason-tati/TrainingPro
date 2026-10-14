// WP-18 · E9 — Enterprise Version Management Engine Foundation tests.
// Exhaustively exercises the version manager (create/revision/increment/compare/validate/
// normalize/freeze/clone/merge/snapshot) and the version history (create/append/remove/
// replace/find/latest/previous/next/list/compare/validate/normalize/freeze/clone). Covers
// hostile inputs, never-throw, determinism, immutability, fresh copies, futureReserved,
// export surface, and the unwired requirement. Pure in-memory — no DB, no network.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-version-manager.js'));
const H = require(path.join(EDIR, 'document-version-history.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const VERSION_FIELDS = ['scheme', 'major', 'minor', 'patch', 'revision', 'label', 'effectiveDate', 'expiryDate', 'obsoleteDate', 'status', 'changeSummary', 'author', 'approvedBy', 'approvedDate', 'previousVersion', 'nextVersion', 'metadata', 'futureReserved'];

// ---------------------------------------------------------------------------
// manager: create / coercion
// ---------------------------------------------------------------------------

test('E9-1. createVersion: full structure, coercion, scheme resolution', () => {
  const v = M.createVersion();
  assert.deepEqual(Object.keys(v), VERSION_FIELDS);
  assert.equal(v.scheme, 'NONE'); // no scheme → default
  assert.equal(v.major, 0);
  assert.equal(v.revision, '');
  assert.equal(v.effectiveDate, null);
  assert.equal(v.previousVersion, null);
  assert.deepEqual(v.metadata, {});
  assert.deepEqual(v.futureReserved, []);
  const c = M.createVersion({ scheme: 'SEMANTIC', major: 3, minor: 2.9, patch: 'x', revision: 'A', effectiveDate: '', previousVersion: 5, metadata: [1], futureReserved: 'no' });
  assert.equal(c.scheme, 'SEMANTIC');
  assert.equal(c.major, 3); // integer kept
  assert.equal(c.minor, 2); // float truncated
  assert.equal(c.patch, 0); // non-number → 0
  assert.equal(c.effectiveDate, null); // '' → null
  assert.equal(c.previousVersion, null); // non-string ref → null
  assert.deepEqual(c.metadata, {}); // array → {}
  assert.deepEqual(c.futureReserved, []); // non-array → []
  assert.equal(M.createVersion({}, { scheme: 'REVISION' }).scheme, 'REVISION'); // options.scheme
  assert.equal(M.createVersion({}, { defaultScheme: 'ISO_DOCUMENT' }).scheme, 'ISO_DOCUMENT'); // options.defaultScheme
  assert.equal(M.createVersion({ effectiveDate: '2026-01-01' }).effectiveDate, '2026-01-01'); // non-empty date string kept
  assert.equal(M.createVersion({ previousVersion: '1.0.0' }).previousVersion, '1.0.0'); // non-empty ref kept
  assert.equal(M.createVersion({ previousVersion: '' }).previousVersion, null); // empty ref → null
});

test('E9-2. increment major / minor / patch (+ bump metadata) and revision (letters / numbers)', () => {
  const base = M.createVersion({ scheme: 'SEMANTIC', major: 1, minor: 3, patch: 5, revision: 'A' });
  assert.deepEqual([M.incrementMajor(base).major, M.incrementMajor(base).minor, M.incrementMajor(base).patch], [2, 0, 0]);
  assert.deepEqual([M.incrementMinor(base).minor, M.incrementMinor(base).patch], [4, 0]);
  assert.equal(M.incrementPatch(base).patch, 6);
  assert.equal(M.incrementMajor({}).major, 1); // absent → default 0 then +1
  // bump metadata options applied
  const withMeta = M.incrementMinor(base, { author: 'bob', changeSummary: 'fix', status: 'DRAFT', effectiveDate: '2026-01-01' });
  assert.deepEqual([withMeta.author, withMeta.changeSummary, withMeta.status, withMeta.effectiveDate], ['bob', 'fix', 'DRAFT', '2026-01-01']);
  // revision progression
  assert.equal(M.incrementRevision({ revision: 'A' }).revision, 'B');
  assert.equal(M.incrementRevision({ revision: 'Z' }).revision, 'AA');
  assert.equal(M.incrementRevision({ revision: '9' }).revision, '10');
  assert.equal(M.incrementRevision({ revision: '' }).revision, 'A');
  assert.equal(M.incrementRevision({ revision: 'AB' }).revision, 'A'); // non A-Z / non-numeric → 'A'
});

test('E9-3. createRevision: bumps revision and links previousVersion', () => {
  const r = M.createRevision({ scheme: 'REVISION', major: 1, minor: 2, patch: 0, revision: 'B' });
  assert.equal(r.revision, 'C');
  assert.equal(r.previousVersion, '1.2.0-B');
});

// ---------------------------------------------------------------------------
// manager: compare
// ---------------------------------------------------------------------------

test('E9-4. compareVersions: older / newer / equal / incompatible; ordering by each part', () => {
  const s = (o) => Object.assign({ scheme: 'SEMANTIC' }, o);
  assert.equal(M.compareVersions(s({ major: 1 }), s({ major: 2 })), 'older');
  assert.equal(M.compareVersions(s({ major: 2 }), s({ major: 1 })), 'newer');
  assert.equal(M.compareVersions(s({ major: 1, minor: 1 }), s({ major: 1, minor: 2 })), 'older'); // minor tiebreak
  assert.equal(M.compareVersions(s({ major: 1, minor: 1, patch: 1 }), s({ major: 1, minor: 1, patch: 2 })), 'older'); // patch tiebreak
  assert.equal(M.compareVersions(s({ revision: 'A' }), s({ revision: 'B' })), 'older'); // revision tiebreak (lexicographic)
  assert.equal(M.compareVersions(s({ revision: 'B' }), s({ revision: 'A' })), 'newer'); // revision lexicographic (greater)
  assert.equal(M.compareVersions(s({ revision: '2' }), s({ revision: '10' })), 'older'); // revision numeric
  assert.equal(M.compareVersions(s({ major: 1 }), s({ major: 1 })), 'equal');
  assert.equal(M.compareVersions({ scheme: 'SEMANTIC' }, { scheme: 'REVISION' }), 'incompatible');
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E9-5. validateVersion: shape, scheme, numbers, revision, dates, date order', () => {
  assert.equal(M.validateVersion({ scheme: 'SEMANTIC', major: 1, minor: 0, patch: 0 }).valid, true);
  const nonObj = M.validateVersion(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_VERSION');
  const codes = (v) => M.validateVersion(v).errors.map((e) => e.code);
  assert.ok(codes({}).includes('MISSING_SCHEME'));
  assert.ok(codes({ scheme: 'FOO' }).includes('UNKNOWN_SCHEME'));
  assert.ok(codes({ scheme: 'SEMANTIC', major: -1 }).includes('INVALID_NUMBER'));
  assert.ok(codes({ scheme: 'SEMANTIC', minor: 1.5 }).includes('INVALID_NUMBER'));
  assert.ok(codes({ scheme: 'SEMANTIC', revision: 5 }).includes('INVALID_REVISION'));
  assert.ok(codes({ scheme: 'SEMANTIC', effectiveDate: 'not-a-date' }).includes('INVALID_DATE'));
  assert.ok(codes({ scheme: 'CONTROLLED_DOCUMENT', effectiveDate: '2026-06-01', expiryDate: '2026-01-01' }).includes('DATE_ORDER'));
  // null / undefined date fields are skipped (not errors)
  assert.equal(M.validateVersion({ scheme: 'SEMANTIC', effectiveDate: null, expiryDate: undefined }).valid, true);
});

test('E9-6. validateVersion: pure date validation (leap years, ranges, times)', () => {
  const okDate = (d) => M.validateVersion({ scheme: 'CONTROLLED_DOCUMENT', effectiveDate: d }).errors.every((e) => e.code !== 'INVALID_DATE');
  for (const d of ['2026-01-01', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01T10:20', '2026-01-01T10:20:30', '2026-01-01T10:20:30.5Z', '2026-01-01T10:20:30+10:00']) {
    assert.equal(okDate(d), true, `valid: ${d}`);
  }
  for (const d of ['2026-13-01', '2026-00-01', '2026-01-00', '2026-02-30', '2023-02-29', '1900-02-29', '2026-01-01T24:00', '2026-01-01T10:60', '2026-01-01T10:10:60', 'nope']) {
    assert.equal(okDate(d), false, `invalid: ${d}`);
  }
});

test('E9-7. validateVersion: scheme-aware warnings (supported vs unsupported)', () => {
  const warns = (v) => M.validateVersion(v).warnings.map((w) => w.code);
  // REVISION supports only revision: major/minor/patch/effectiveDate all warn; revision does NOT warn
  const rev = warns({ scheme: 'REVISION', major: 1, minor: 1, patch: 1, revision: 'A', effectiveDate: '2026-01-01' });
  assert.ok(rev.includes('MAJOR_UNSUPPORTED') && rev.includes('MINOR_UNSUPPORTED') && rev.includes('PATCH_UNSUPPORTED') && rev.includes('EFFECTIVE_UNSUPPORTED'));
  assert.equal(rev.includes('REVISION_UNSUPPORTED'), false);
  // SEMANTIC supports major/minor/patch/effectiveDate (no warns) but not revision → REVISION_UNSUPPORTED
  const sem = warns({ scheme: 'SEMANTIC', major: 1, minor: 1, patch: 1, revision: 'A', effectiveDate: '2026-01-01' });
  assert.deepEqual(sem, ['REVISION_UNSUPPORTED']);
  // unsupported but value 0/absent → no warning
  assert.deepEqual(warns({ scheme: 'REVISION', revision: 'A' }), []);
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / freeze / clone / snapshot
// ---------------------------------------------------------------------------

test('E9-8. normalizeVersion: trim strings, normalize metadata + arrays, integer numbers', () => {
  const n = M.normalizeVersion({ scheme: 'SEMANTIC', major: 2.7, label: '  L  ', status: '  s  ', metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x', ''] });
  assert.equal(n.major, 2);
  assert.equal(n.label, 'L');
  assert.equal(n.status, 's');
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.nested, { z: 2 }); // nested object normalized (normalizeAny → normalizeObject)
  assert.deepEqual(n.metadata.arr, [1, 2, 3]); // nested array sorted (normalizeAny → normalizeArray + comparator)
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]); // object dedupe (canon JSON) + trim + drop empty + sort
});

test('E9-9. mergeVersions: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeVersions({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeVersions({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeVersions({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeVersions({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeVersions({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeVersions({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeVersions({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeVersions({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeVersions({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeVersions({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeVersions(5, { a: 1 }), { a: 1 });
});

test('E9-10. freeze / clone: deep, never freeze/mutate caller; non-object coerced', () => {
  const src = { scheme: 'SEMANTIC', metadata: { a: 1 }, futureReserved: [1] };
  const frozen = M.freezeVersion(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.futureReserved));
  assert.equal(Object.isFrozen(src), false);
  const clone = M.cloneVersion(src);
  assert.notEqual(clone.metadata, src.metadata);
  assert.deepEqual(clone, src);
  assert.deepEqual(M.cloneVersion(5), {});
  assert.deepEqual(M.freezeVersion(5), {});
});

test('E9-11. generateVersionSnapshot: deterministic, immutable, digested', () => {
  const v = { scheme: 'SEMANTIC', major: 1 };
  const s1 = M.generateVersionSnapshot(v);
  const s2 = M.generateVersionSnapshot(v);
  assert.equal(s1.schema, 'enterprise-version.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, s2.digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.version));
  assert.notEqual(s1.digest, M.generateVersionSnapshot({ scheme: 'SEMANTIC', major: 2 }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E9-12. createHistory + listVersions: structure, coercion, documentId variants', () => {
  const h = H.createHistory({ documentId: 'D1', scheme: 'SEMANTIC', versions: [{ scheme: 'SEMANTIC', major: 1 }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['documentId', 'scheme', 'versions', 'metadata', 'futureReserved']);
  assert.equal(h.documentId, 'D1');
  assert.equal(h.versions.length, 1);
  assert.equal(H.createHistory({}).documentId, null); // absent → null
  assert.equal(H.createHistory({ documentId: null }).documentId, null); // null → null
  assert.equal(H.createHistory({ documentId: 7 }).documentId, 7); // other → kept
  assert.equal(H.createHistory({}).scheme, 'NONE'); // absent scheme → NONE
  assert.deepEqual(H.createHistory({ versions: 'no', metadata: 5, futureReserved: 9 }).versions, []); // non-array versions → []
  assert.deepEqual(H.listVersions({ versions: [{ scheme: 'NONE' }] }).length, 1);
});

test('E9-13. append / remove / replace: immutable, key-based', () => {
  const h = H.createHistory({ versions: [{ scheme: 'SEMANTIC', major: 1 }] });
  const app = H.appendVersion(h, { scheme: 'SEMANTIC', major: 2 });
  assert.equal(app.versions.length, 2);
  assert.equal(h.versions.length, 1); // original unchanged
  const rem = H.removeVersion(app, '1.0.0');
  assert.equal(rem.versions.length, 1);
  assert.equal(rem.versions[0].major, 2);
  assert.equal(H.removeVersion(app, null).versions.length, 2); // null key matches nothing
  const rep = H.replaceVersion(app, '2.0.0', { scheme: 'SEMANTIC', major: 9 });
  assert.equal(rep.versions.find((v) => v.major === 9) !== undefined, true);
  assert.equal(H.replaceVersion(app, 'no-match', { major: 5 }).versions.some((v) => v.major === 5), false);
});

test('E9-14. find: version / latest / previous / next; labels; empty history', () => {
  const h = H.createHistory({ versions: [{ scheme: 'SEMANTIC', major: 1 }, { scheme: 'SEMANTIC', major: 3 }, { scheme: 'SEMANTIC', major: 2 }] });
  assert.equal(H.findVersion(h, '3.0.0').major, 3);
  assert.equal(H.findVersion(h, '9.9.9'), null);
  assert.equal(H.findVersion(h, null), null);
  assert.equal(H.findLatest(h).major, 3);
  assert.equal(H.findLatest({ versions: [] }), null); // empty
  assert.equal(H.findPrevious(h, '2.0.0').major, 1);
  assert.equal(H.findPrevious(h, '1.0.0'), null); // first has no previous
  assert.equal(H.findPrevious(h, 'nope'), null); // not found
  assert.equal(H.findNext(h, '2.0.0').major, 3);
  assert.equal(H.findNext(h, '3.0.0'), null); // last has no next
  assert.equal(H.findNext(h, 'nope'), null); // not found
  // label key + incompatible-scheme ordering fallback
  const labelled = H.createHistory({ versions: [{ scheme: 'SEMANTIC', major: 1, label: 'v1' }, { scheme: 'REVISION', revision: 'A', label: 'rA' }] });
  assert.equal(H.findVersion(labelled, 'v1').major, 1);
  assert.ok(H.findLatest(labelled) !== null); // mixed schemes still order deterministically
});

test('E9-15. compareHistory: added / removed / modified / unchanged by version key', () => {
  const same = { scheme: 'SEMANTIC', major: 5, metadata: { a: [1, 2] }, futureReserved: ['r'] };
  const a = H.createHistory({ versions: [{ scheme: 'SEMANTIC', major: 1 }, { scheme: 'SEMANTIC', major: 2, label: 'x' }, same] });
  const b = H.createHistory({ versions: [{ scheme: 'SEMANTIC', major: 1, changeSummary: 'edited' }, { scheme: 'SEMANTIC', major: 3 }, same] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['3.0.0']);
  assert.deepEqual(d.removed, ['x']); // label key of the 2.0.0 version
  assert.deepEqual(d.modified, ['1.0.0']);
  assert.deepEqual(d.unchanged, ['5.0.0']); // deep-equal version incl. nested array + object
});

test('E9-16. validateHistory: shape, per-version, duplicates, broken links', () => {
  const ok = H.validateHistory({ versions: [{ scheme: 'SEMANTIC', major: 1 }] });
  assert.equal(ok.valid, true);
  assert.deepEqual(Object.keys(ok).sort(), ['brokenLinks', 'duplicateVersions', 'errors', 'valid', 'warnings']);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ versions: 'no' }).errors.some((e) => e.code === 'INVALID_VERSIONS'));
  const dup = H.validateHistory({ versions: [{ scheme: 'SEMANTIC', major: 1 }, { scheme: 'SEMANTIC', major: 1 }] });
  assert.deepEqual(dup.duplicateVersions, ['1.0.0']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_VERSION'));
  // per-version errors bubble up; broken vs valid links
  const linked = H.validateHistory({ versions: [
    { scheme: 'SEMANTIC', major: 1, previousVersion: '' }, // empty ref → skipped
    { scheme: 'FOO', major: 2, previousVersion: '1.0.0', nextVersion: 'ghost' }, // 1.0.0 exists (ok), ghost broken; FOO → per-version UNKNOWN_SCHEME
  ] });
  assert.ok(linked.errors.some((e) => e.code === 'UNKNOWN_SCHEME'));
  assert.deepEqual(linked.brokenLinks, ['2.0.0.nextVersion→ghost']);
  assert.ok(linked.warnings.some((w) => w.code === 'BROKEN_LINK'));
  // per-version scheme warnings bubble up into history warnings
  const warn = H.validateHistory({ versions: [{ scheme: 'REVISION', major: 2 }] }); // major>0 on REVISION → MAJOR_UNSUPPORTED
  assert.ok(warn.warnings.some((w) => w.code === 'MAJOR_UNSUPPORTED'));
});

test('E9-23. history internals: nested deepEqual, equal + incompatible ordering, revision-key', () => {
  const mk = (major, over) => Object.assign({ scheme: 'SEMANTIC', major }, over);
  const A = H.createHistory({ versions: [mk(10, { futureReserved: ['p'] }), mk(11, { futureReserved: ['p'] }), mk(12, { metadata: { a: 1 } }), mk(13, { metadata: { a: 1 } })] });
  const B = H.createHistory({ versions: [mk(10, { futureReserved: ['p', 'q'] }), mk(11, { futureReserved: ['q'] }), mk(12, { metadata: { a: 1, b: 2 } }), mk(13, { metadata: { b: 1 } })] });
  // array-length, array-element, object-keycount, object-keyname mismatches all → modified
  assert.deepEqual(H.compareHistory(A, B).modified, ['10.0.0', '11.0.0', '12.0.0', '13.0.0']);
  // versionKey from major.minor.patch-revision when no label is present
  const revHist = H.createHistory({ versions: [{ scheme: 'REVISION', revision: 'A' }] });
  assert.equal(H.findVersion(revHist, '0.0.0-A').revision, 'A');
  // equal (compatible) versions → orderVersions 0 + stable index tiebreak
  const eqHist = H.createHistory({ versions: [{ scheme: 'SEMANTIC', major: 1 }, { scheme: 'SEMANTIC', major: 1 }] });
  assert.equal(H.findLatest(eqHist).major, 1);
  assert.equal(H.normalizeHistory(eqHist).versions.length, 2);
  // incompatible schemes → key fallback: greater-key and equal-key branches
  assert.ok(H.findLatest(H.createHistory({ versions: [{ scheme: 'SEMANTIC', label: 'aaa' }, { scheme: 'REVISION', label: 'zzz' }] })) !== null); // ka>kb
  assert.ok(H.findLatest(H.createHistory({ versions: [{ scheme: 'SEMANTIC', label: 'same' }, { scheme: 'REVISION', label: 'same' }] })) !== null); // ka===kb
});

test('E9-17. normalizeHistory / freeze / clone: sorted, normalized, immutable, no caller freeze', () => {
  const h = { documentId: 'D', scheme: 'SEMANTIC', versions: [{ scheme: 'SEMANTIC', major: 3 }, { scheme: 'SEMANTIC', major: 1 }, { scheme: 'SEMANTIC', major: 2 }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(n.versions.map((v) => v.major), [1, 2, 3]); // sorted
  assert.deepEqual(Object.keys(n), ['documentId', 'scheme', 'versions', 'metadata', 'futureReserved']);
  assert.equal(n.metadata.b, 'y'); // string trimmed
  assert.deepEqual(n.metadata.a, { n: 1 }); // non-string deep-cloned
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.versions) && Object.isFrozen(frozen.versions[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  const clone = H.cloneHistory(h);
  assert.notEqual(clone.versions, h.versions);
  assert.deepEqual(clone, h);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E9-18. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['cloneVersion', 'compareVersions', 'createRevision', 'createVersion', 'freezeVersion', 'generateVersionSnapshot', 'incrementMajor', 'incrementMinor', 'incrementPatch', 'incrementRevision', 'mergeVersions', 'normalizeVersion', 'validateVersion']);
  assert.deepEqual(Object.keys(H).sort(), ['appendVersion', 'cloneHistory', 'compareHistory', 'createHistory', 'findLatest', 'findNext', 'findPrevious', 'findVersion', 'freezeHistory', 'listVersions', 'normalizeHistory', 'removeVersion', 'replaceVersion', 'validateHistory']);
});

test('E9-19. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { major: 'x' }, { scheme: 5 }, { versions: 5 }, { revision: {} }];
  for (const a of hostile) {
    for (const fn of ['createVersion', 'createRevision', 'incrementMajor', 'incrementMinor', 'incrementPatch', 'incrementRevision', 'validateVersion', 'normalizeVersion', 'freezeVersion', 'cloneVersion', 'generateVersionSnapshot']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    noThrow(() => M.compareVersions(a, a), 'M.compareVersions');
    noThrow(() => M.mergeVersions(a, a, a), 'M.mergeVersions');
    for (const fn of ['createHistory', 'listVersions', 'findLatest', 'validateHistory', 'normalizeHistory', 'freezeHistory', 'cloneHistory']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendVersion', 'removeVersion', 'findVersion', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceVersion(a, a, a), 'H.replaceVersion');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E9-20. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ scheme: 'SEMANTIC', major: 1, metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createVersion(input), 'create frozen');
  noThrow(() => M.normalizeVersion(input), 'normalize frozen');
  noThrow(() => M.incrementMajor(input), 'increment frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap); // unchanged
  assert.deepEqual(M.createVersion({ scheme: 'SEMANTIC', major: 1 }), M.createVersion({ scheme: 'SEMANTIC', major: 1 })); // deterministic
  const a = M.createVersion({ scheme: 'SEMANTIC' });
  const b = M.createVersion({ scheme: 'SEMANTIC' });
  assert.notEqual(a.futureReserved, b.futureReserved); // fresh arrays
  assert.equal(M.generateVersionSnapshot(input).digest, M.generateVersionSnapshot(input).digest);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E9-21. version modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-version-manager.js', 'document-version-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E9-22. version engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
