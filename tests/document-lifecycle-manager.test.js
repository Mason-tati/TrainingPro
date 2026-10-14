// WP-18 · E10 — Enterprise Document Lifecycle Engine Foundation tests.
// Exhaustively exercises the lifecycle manager (create/transition/canTransition/validate*/
// normalize/clone/freeze/merge/compare/snapshot) and the lifecycle history (create/append/
// replace/remove/find/latest/previous/next/compare/validate/normalize/clone/freeze). Covers
// normal + illegal + rollback + no-op + unknown transitions, hostile inputs, never-throw,
// determinism, immutability, copy-on-read, futureReserved, export surface, and unwired. Pure.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-lifecycle-manager.js'));
const H = require(path.join(EDIR, 'document-lifecycle-history.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const LC_FIELDS = ['status', 'previousStatus', 'workflow', 'reason', 'performedBy', 'approvedBy', 'timestamp', 'effectiveDate', 'comment', 'metadata', 'futureReserved'];

// ---------------------------------------------------------------------------
// manager: create
// ---------------------------------------------------------------------------

test('E10-1. createLifecycle: full structure, coercion, status/workflow defaults', () => {
  const lc = M.createLifecycle();
  assert.deepEqual(Object.keys(lc), LC_FIELDS);
  assert.equal(lc.status, 'DRAFT'); // default
  assert.equal(lc.workflow, 'NONE'); // default
  assert.equal(lc.timestamp, null);
  assert.deepEqual(lc.metadata, {});
  assert.deepEqual(lc.futureReserved, []);
  const c = M.createLifecycle({ status: 'PUBLISHED', workflow: 'STANDARD', reason: 5, timestamp: '', effectiveDate: '2026-01-01', metadata: [1], futureReserved: 'no' });
  assert.equal(c.status, 'PUBLISHED');
  assert.equal(c.workflow, 'STANDARD');
  assert.equal(c.reason, '5'); // number → string
  assert.equal(c.timestamp, null); // '' → null
  assert.equal(c.effectiveDate, '2026-01-01'); // non-empty date kept
  assert.deepEqual(c.metadata, {}); // array → {}
  assert.deepEqual(c.futureReserved, []); // non-array → []
  assert.equal(M.createLifecycle({}, { status: 'APPROVED' }).status, 'APPROVED'); // options.status
  assert.equal(M.createLifecycle({}, { defaultStatus: 'IN_REVIEW', defaultWorkflow: 'FORM' }).workflow, 'FORM'); // option defaults
});

// ---------------------------------------------------------------------------
// manager: transition legality
// ---------------------------------------------------------------------------

test('E10-2. canTransition / validateTransition: forward, no-op, rollback, illegal, unknown', () => {
  assert.equal(M.canTransition('DRAFT', 'IN_REVIEW', 'STANDARD'), true); // forward
  assert.equal(M.canTransition('DRAFT', 'DRAFT', 'STANDARD'), true); // no-op
  assert.equal(M.canTransition('IN_REVIEW', 'DRAFT', 'STANDARD'), true); // rollback (workflow supports)
  assert.equal(M.canTransition('IN_REVIEW', 'DRAFT', 'FORM'), false); // rollback not permitted
  assert.equal(M.canTransition('DRAFT', 'PUBLISHED', 'STANDARD'), false); // illegal (skips a step)
  assert.equal(M.canTransition('DRAFT', 'ARCHIVED', 'STANDARD'), false); // illegal (no forward/rollback)
  assert.equal(M.canTransition('FOO', 'DRAFT', 'STANDARD'), false); // unknown from
  assert.equal(M.canTransition('DRAFT', 'BAR', 'STANDARD'), false); // unknown to
  assert.equal(M.canTransition(5, 'DRAFT', 'STANDARD'), false); // non-string from
  // validateTransition detail
  const v = M.validateTransition('IN_REVIEW', 'DRAFT', 'FORM');
  assert.equal(v.valid, false);
  assert.equal(v.kind, 'illegal');
  assert.ok(v.errors.some((e) => e.code === 'ROLLBACK_NOT_ALLOWED'));
  const legal = M.validateTransition('APPROVED', 'PUBLISHED', 'STANDARD');
  assert.equal(legal.kind, 'forward');
  assert.ok(M.validateTransition('FOO', 'BAR', 'STANDARD').errors.some((e) => e.code === 'UNKNOWN_FROM_STATUS'));
  assert.ok(M.validateTransition('FOO', 'BAR', 'STANDARD').errors.some((e) => e.code === 'UNKNOWN_TO_STATUS'));
});

test('E10-3. transition: produces result + lifecycle; valid advances, invalid stays; unknown workflow safe', () => {
  const ok = M.transition({ status: 'DRAFT', workflow: 'STANDARD' }, 'IN_REVIEW', { performedBy: 'a', timestamp: '2026-01-01' });
  assert.equal(ok.valid, true);
  assert.equal(ok.kind, 'forward');
  assert.equal(ok.lifecycle.status, 'IN_REVIEW');
  assert.equal(ok.lifecycle.previousStatus, 'DRAFT');
  assert.equal(ok.lifecycle.performedBy, 'a');
  const rollback = M.transition({ status: 'APPROVED' }, 'UNDER_APPROVAL', { workflow: 'STANDARD' });
  assert.equal(rollback.kind, 'rollback');
  const bad = M.transition({ status: 'DRAFT', workflow: 'STANDARD' }, 'PUBLISHED');
  assert.equal(bad.valid, false);
  assert.equal(bad.lifecycle.status, 'DRAFT'); // unchanged on illegal
  assert.ok(bad.errors.some((e) => e.code === 'ILLEGAL_TRANSITION'));
  // to = null/undefined handled safely (unknown target → invalid, status stays)
  assert.equal(M.transition({ status: 'DRAFT' }, null).valid, false);
  assert.equal(M.transition({ status: 'DRAFT' }, undefined).lifecycle.status, 'DRAFT');
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E10-4. validateLifecycle: shape, status, previous/workflow warnings, dates, illegal sequence', () => {
  assert.equal(M.validateLifecycle({ status: 'IN_REVIEW', previousStatus: 'DRAFT', workflow: 'STANDARD' }).valid, true);
  const nonObj = M.validateLifecycle(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_LIFECYCLE');
  const codes = (lc) => M.validateLifecycle(lc).errors.map((e) => e.code);
  const warns = (lc) => M.validateLifecycle(lc).warnings.map((w) => w.code);
  assert.ok(codes({}).includes('MISSING_STATUS')); // empty status
  assert.ok(codes({ status: 'FOO' }).includes('UNKNOWN_STATUS'));
  assert.ok(warns({ status: 'DRAFT', previousStatus: 'GHOST' }).includes('UNKNOWN_PREVIOUS_STATUS'));
  assert.ok(warns({ status: 'DRAFT', workflow: 'MADEUP' }).includes('UNKNOWN_WORKFLOW'));
  assert.ok(codes({ status: 'DRAFT', timestamp: 'bad' }).includes('INVALID_DATE'));
  assert.ok(warns({ status: 'DRAFT', timestamp: '2026-06-01', effectiveDate: '2026-01-01' }).includes('DATE_ORDER'));
  // illegal recorded transition (previous → status not legal)
  assert.ok(codes({ status: 'PUBLISHED', previousStatus: 'DRAFT', workflow: 'STANDARD' }).includes('ILLEGAL_TRANSITION'));
  // null / undefined dates skipped
  assert.equal(M.validateLifecycle({ status: 'DRAFT', timestamp: null, effectiveDate: undefined }).valid, true);
});

test('E10-5. validateLifecycle: pure date validation (leap years, ranges, times)', () => {
  const okDate = (d) => M.validateLifecycle({ status: 'DRAFT', timestamp: d }).errors.every((e) => e.code !== 'INVALID_DATE');
  for (const d of ['2026-01-01', '2024-02-29', '2000-02-29', '2026-12-31', '2026-01-01T10:20', '2026-01-01T10:20:30', '2026-01-01T10:20:30.5Z', '2026-01-01T10:20:30+10:00']) {
    assert.equal(okDate(d), true, `valid: ${d}`);
  }
  for (const d of ['2026-13-01', '2026-00-01', '2026-01-00', '2026-02-30', '2023-02-29', '1900-02-29', '2026-01-01T24:00', '2026-01-01T10:60', '2026-01-01T10:10:60', 'nope']) {
    assert.equal(okDate(d), false, `invalid: ${d}`);
  }
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E10-6. normalizeLifecycle: trim strings, normalize nested metadata + arrays', () => {
  const n = M.normalizeLifecycle({ status: 'DRAFT', reason: '  r  ', comment: '  c  ', metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x', ''] });
  assert.equal(n.reason, 'r');
  assert.equal(n.comment, 'c');
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]); // dedupe + trim + drop empty + sort (canon)
});

test('E10-7. mergeLifecycle: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeLifecycle({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeLifecycle({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeLifecycle({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeLifecycle({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeLifecycle({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeLifecycle({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeLifecycle({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeLifecycle({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeLifecycle({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeLifecycle({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeLifecycle(5, { a: 1 }), { a: 1 });
});

test('E10-8. compareLifecycle: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareLifecycle({ status: 'DRAFT', reason: 'x', metadata: { a: 1 }, same: 1 }, { status: 'IN_REVIEW', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['reason']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareLifecycle(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareLifecycle({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareLifecycle({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E10-9. clone / freeze / snapshot: deep, immutable, deterministic, caller-safe', () => {
  const src = { status: 'DRAFT', metadata: { a: 1 }, futureReserved: [1] };
  const frozen = M.freezeLifecycle(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.futureReserved));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneLifecycle(src).metadata, src.metadata);
  assert.deepEqual(M.cloneLifecycle(5), {});
  assert.deepEqual(M.freezeLifecycle(5), {});
  const s1 = M.generateLifecycleSnapshot(src);
  assert.equal(s1.schema, 'enterprise-lifecycle.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateLifecycleSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.lifecycle));
  assert.notEqual(s1.digest, M.generateLifecycleSnapshot({ status: 'PUBLISHED' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E10-10. createHistory: structure, coercion, documentId variants', () => {
  const h = H.createHistory({ documentId: 'D1', workflow: 'STANDARD', transitions: [{ status: 'DRAFT' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['documentId', 'workflow', 'transitions', 'metadata', 'futureReserved']);
  assert.equal(h.documentId, 'D1');
  assert.equal(h.transitions.length, 1);
  assert.equal(H.createHistory({}).documentId, null);
  assert.equal(H.createHistory({ documentId: null }).documentId, null);
  assert.equal(H.createHistory({ documentId: 7 }).documentId, 7);
  assert.equal(H.createHistory({}).workflow, 'NONE');
  assert.deepEqual(H.createHistory({ transitions: 'no', metadata: 5, futureReserved: 9 }).transitions, []);
});

test('E10-11. append / replace / remove: immutable, key-based', () => {
  const h = H.createHistory({ transitions: [{ status: 'DRAFT', timestamp: 't1' }] });
  const app = H.appendTransition(h, { status: 'IN_REVIEW', timestamp: 't2' });
  assert.equal(app.transitions.length, 2);
  assert.equal(h.transitions.length, 1); // original unchanged
  const rep = H.replaceTransition(app, 't1', { status: 'ARCHIVED', timestamp: 't1' });
  assert.equal(rep.transitions.find((t) => t.status === 'ARCHIVED') !== undefined, true);
  assert.equal(H.replaceTransition(app, 'none', { status: 'X' }).transitions.some((t) => t.status === 'X'), false);
  const rem = H.removeTransition(app, 't1');
  assert.equal(rem.transitions.length, 1);
  assert.equal(H.removeTransition(app, null).transitions.length, 2); // null key matches nothing
});

test('E10-12. find: transition / latest / previous / next; status-key fallback; empty', () => {
  const h = H.createHistory({ transitions: [{ status: 'DRAFT', timestamp: '2026-01-01' }, { status: 'PUBLISHED', timestamp: '2026-03-01' }, { status: 'IN_REVIEW', timestamp: '2026-02-01' }] });
  assert.equal(H.findTransition(h, '2026-03-01').status, 'PUBLISHED');
  assert.equal(H.findTransition(h, 'nope'), null);
  assert.equal(H.findTransition(h, null), null);
  assert.equal(H.findLatest(h).status, 'PUBLISHED'); // latest by timestamp
  assert.equal(H.findLatest({ transitions: [] }), null);
  assert.equal(H.findPrevious(h, '2026-02-01').status, 'DRAFT');
  assert.equal(H.findPrevious(h, '2026-01-01'), null); // first has no previous
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, '2026-02-01').status, 'PUBLISHED');
  assert.equal(H.findNext(h, '2026-03-01'), null); // last has no next
  assert.equal(H.findNext(h, 'nope'), null);
  // status-key fallback when no timestamp; equal-timestamp index tiebreak
  const noTs = H.createHistory({ transitions: [{ status: 'DRAFT' }, { status: 'IN_REVIEW' }] });
  assert.equal(H.findTransition(noTs, 'IN_REVIEW').status, 'IN_REVIEW');
  assert.equal(H.findLatest(noTs).status, 'IN_REVIEW'); // no timestamps → order by insertion index
  const tie = H.createHistory({ transitions: [{ status: 'DRAFT', timestamp: 't' }, { status: 'IN_REVIEW', timestamp: 't' }] });
  assert.equal(H.findLatest(tie).status, 'IN_REVIEW'); // equal ts → insertion tiebreak
});

test('E10-13. compareHistory / validateHistory: keys, duplicates, broken sequence, per-transition', () => {
  const a = H.createHistory({ transitions: [{ status: 'DRAFT', timestamp: 't1' }, { status: 'IN_REVIEW', timestamp: 't2' }] });
  const b = H.createHistory({ transitions: [{ status: 'DRAFT', timestamp: 't1', comment: 'edited' }, { status: 'APPROVED', timestamp: 't3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['t3']);
  assert.deepEqual(d.removed, ['t2']);
  assert.deepEqual(d.modified, ['t1']);
  assert.deepEqual(d.unchanged, []);
  // validation (valid ISO timestamps so per-transition date checks pass)
  assert.equal(H.validateHistory({ transitions: [{ status: 'DRAFT', timestamp: '2026-01-01' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ transitions: 'no' }).errors.some((e) => e.code === 'INVALID_TRANSITIONS'));
  const dup = H.validateHistory({ transitions: [{ status: 'DRAFT', timestamp: '2026-01-01' }, { status: 'IN_REVIEW', timestamp: '2026-01-01' }] });
  assert.deepEqual(dup.duplicateTransitions, ['2026-01-01']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_TRANSITION'));
  // per-transition error bubbles up; broken sequence warning (declared previous ≠ prior status)
  const seq = H.validateHistory({ transitions: [{ status: 'DRAFT', timestamp: '2026-01-01' }, { status: 'FOO', timestamp: '2026-01-02', previousStatus: 'PUBLISHED' }] });
  assert.ok(seq.errors.some((e) => e.code === 'UNKNOWN_STATUS')); // FOO invalid per-transition
  assert.deepEqual(seq.brokenSequence, ['2026-01-02:PUBLISHED≠DRAFT']);
  assert.ok(seq.warnings.some((w) => w.code === 'BROKEN_SEQUENCE'));
  // empty transition → key '' (no timestamp/status); per-transition warning bubbles up
  const edge = H.validateHistory({ transitions: [{}, { status: 'DRAFT', timestamp: '2026-01-01', previousStatus: 'GHOST' }] });
  assert.ok(edge.errors.some((e) => e.code === 'MISSING_STATUS')); // {} → missing status
  assert.ok(edge.warnings.some((w) => w.code === 'UNKNOWN_PREVIOUS_STATUS')); // per-transition warning bubbled
});

test('E10-14. compareHistory: deepEqual structural mismatches (unchanged incl. nested)', () => {
  const same = { status: 'DRAFT', timestamp: 'k', metadata: { a: [1, 2] }, futureReserved: ['r'] };
  const A = H.createHistory({ transitions: [same,
    { status: 'IN_REVIEW', timestamp: 'x', metadata: { b: 1 } }, // object missing-key
    { status: 'APPROVED', timestamp: 'y', futureReserved: ['p', 'q'] }, // array length
    { status: 'SUPERSEDED', timestamp: 'z', futureReserved: ['p'] }, // array element
    { status: 'ARCHIVED', timestamp: 'w', metadata: { a: 1 } }] }); // object key-count
  const B = H.createHistory({ transitions: [same,
    { status: 'IN_REVIEW', timestamp: 'x', metadata: { a: 1 } },
    { status: 'APPROVED', timestamp: 'y', futureReserved: ['p'] },
    { status: 'SUPERSEDED', timestamp: 'z', futureReserved: ['q'] },
    { status: 'ARCHIVED', timestamp: 'w', metadata: { a: 1, c: 2 } }] });
  const d = H.compareHistory(A, B);
  assert.deepEqual(d.unchanged, ['k']); // deep-equal incl nested array + object
  assert.deepEqual(d.modified.sort(), ['w', 'x', 'y', 'z']); // key-name, array-length, array-element, key-count mismatches
});

test('E10-15. normalizeHistory / clone / freeze: sorted, normalized, immutable, caller-safe', () => {
  const h = { documentId: 'D', workflow: 'STANDARD', transitions: [{ status: 'PUBLISHED', timestamp: 't3' }, { status: 'DRAFT', timestamp: 't1' }, { status: 'IN_REVIEW', timestamp: 't2' }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(n.transitions.map((t) => t.status), ['DRAFT', 'IN_REVIEW', 'PUBLISHED']); // sorted by timestamp
  assert.deepEqual(Object.keys(n), ['documentId', 'workflow', 'transitions', 'metadata', 'futureReserved']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.transitions) && Object.isFrozen(frozen.transitions[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).transitions, h.transitions);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E10-16. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['canTransition', 'cloneLifecycle', 'compareLifecycle', 'createLifecycle', 'freezeLifecycle', 'generateLifecycleSnapshot', 'mergeLifecycle', 'normalizeLifecycle', 'transition', 'validateLifecycle', 'validateTransition']);
  assert.deepEqual(Object.keys(H).sort(), ['appendTransition', 'cloneHistory', 'compareHistory', 'createHistory', 'findLatest', 'findNext', 'findPrevious', 'findTransition', 'freezeHistory', 'normalizeHistory', 'removeTransition', 'replaceTransition', 'validateHistory']);
});

test('E10-17. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { transitions: 5 }];
  for (const a of hostile) {
    for (const fn of ['createLifecycle', 'validateLifecycle', 'normalizeLifecycle', 'cloneLifecycle', 'freezeLifecycle', 'generateLifecycleSnapshot']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    noThrow(() => M.transition(a, a, a), 'M.transition');
    noThrow(() => M.canTransition(a, a, a), 'M.canTransition');
    noThrow(() => M.validateTransition(a, a, a), 'M.validateTransition');
    noThrow(() => M.mergeLifecycle(a, a, a), 'M.mergeLifecycle');
    noThrow(() => M.compareLifecycle(a, a), 'M.compareLifecycle');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendTransition', 'removeTransition', 'findTransition', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceTransition(a, a, a), 'H.replaceTransition');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E10-18. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ status: 'DRAFT', workflow: 'STANDARD', metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createLifecycle(input), 'create frozen');
  noThrow(() => M.transition(input, 'IN_REVIEW'), 'transition frozen');
  noThrow(() => M.normalizeLifecycle(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap); // unchanged
  assert.deepEqual(M.createLifecycle({ status: 'DRAFT' }), M.createLifecycle({ status: 'DRAFT' })); // deterministic
  const a = M.createLifecycle({ status: 'DRAFT' });
  const b = M.createLifecycle({ status: 'DRAFT' });
  assert.notEqual(a.futureReserved, b.futureReserved); // fresh arrays
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E10-19. lifecycle modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-lifecycle-manager.js', 'document-lifecycle-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E10-20. lifecycle engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
