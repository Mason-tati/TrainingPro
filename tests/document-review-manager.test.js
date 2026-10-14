// WP-18 · E12 — Enterprise Document Review Engine Foundation tests.
// Exhaustively exercises the review manager (create/complete/returnForChanges/cancel/restart/
// nextStage/previousStage/canReview/validate/normalize/clone/freeze/merge/compare/snapshot)
// and the review history (create/append/replace/remove/find/latest/previous/next/list/compare/
// validate/normalize/clone/freeze). Covers single + multi + parallel review, return, cancel,
// restart, hostile inputs, never-throw, determinism, immutability, copy-on-read, futureReserved,
// export surface, and unwired. Pure in-memory.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-review-manager.js'));
const H = require(path.join(EDIR, 'document-review-history.js'));
const DW = require(path.join(ROOT, 'lib', 'document', 'document-workflows.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const RV_FIELDS = ['reviewId', 'workflow', 'status', 'currentStage', 'totalStages', 'reviewers', 'completedBy', 'returnedBy', 'decision', 'comments', 'timestamp', 'metadata', 'futureReserved'];
const PARALLEL = DW.DOCUMENT_WORKFLOW_IDS.find((id) => DW.getDocumentWorkflow(id).allowsParallelReview === true);
const NON_PARALLEL = DW.DOCUMENT_WORKFLOW_IDS.find((id) => DW.getDocumentWorkflow(id).allowsParallelReview !== true);

// ---------------------------------------------------------------------------
// manager: create
// ---------------------------------------------------------------------------

test('E12-1. createReview: full structure, coercion, defaults', () => {
  const r = M.createReview();
  assert.deepEqual(Object.keys(r), RV_FIELDS);
  assert.equal(r.status, 'PENDING');
  assert.equal(r.workflow, 'NONE');
  assert.equal(r.currentStage, 1);
  assert.equal(r.totalStages, 1);
  assert.deepEqual(r.completedBy, []);
  assert.deepEqual(r.futureReserved, []);
  const c = M.createReview({ workflow: 'STANDARD', status: 'UNDER_REVIEW', currentStage: 2.9, totalStages: 'x', comments: 5, timestamp: '', metadata: [1], futureReserved: 'no', reviewers: ['a'] });
  assert.equal(c.currentStage, 2);
  assert.equal(c.totalStages, 1);
  assert.equal(c.comments, '5');
  assert.equal(c.timestamp, null);
  assert.deepEqual(c.metadata, {});
  assert.deepEqual(c.futureReserved, []);
  assert.deepEqual(c.reviewers, ['a']);
  assert.equal(M.createReview({}, { workflow: 'FORM' }).workflow, 'FORM');
  assert.equal(M.createReview({}, { defaultStatus: 'RETURNED' }).status, 'RETURNED');
});

// ---------------------------------------------------------------------------
// manager: review decisions
// ---------------------------------------------------------------------------

test('E12-2. completeReview: single completes; multi-stage progresses; parallel; perStage variants; invalid', () => {
  const single = M.createReview({ workflow: NON_PARALLEL });
  const c = M.completeReview(single, 'alice', { comments: 'lgtm', timestamp: '2026-01-01' });
  assert.equal(c.valid, true);
  assert.equal(c.review.status, 'COMPLETED');
  assert.deepEqual(c.review.completedBy, ['alice']);
  assert.equal(c.review.decision, 'complete');
  assert.equal(c.review.comments, 'lgtm');
  // multi-stage progression (perStage 1 on a non-parallel workflow)
  const multi = M.createReview({ workflow: NON_PARALLEL, totalStages: 2 });
  const s1 = M.completeReview(multi, 'a');
  assert.equal(s1.review.status, 'UNDER_REVIEW');
  assert.equal(s1.review.currentStage, 1);
  const s2 = M.completeReview(s1.review, 'b');
  assert.equal(s2.review.status, 'COMPLETED');
  assert.equal(s2.review.currentStage, 2);
  // parallel workflow WITH reviewers → perStage = reviewers.length (unanimous)
  const par = M.createReview({ workflow: PARALLEL, reviewers: ['a', 'b'] });
  const p1 = M.completeReview(par, 'a');
  assert.equal(p1.review.status, 'UNDER_REVIEW');
  assert.equal(M.completeReview(p1.review, 'b').review.status, 'COMPLETED');
  // parallel workflow WITHOUT reviewers → perStage falls back to 1
  assert.equal(M.completeReview(M.createReview({ workflow: PARALLEL }), 'a').review.status, 'COMPLETED');
  // invalid: terminal, invalid reviewer, duplicate
  assert.equal(M.completeReview(c.review, 'x').valid, false); // COMPLETED → NOT_REVIEWABLE
  assert.ok(M.completeReview(single, '  ').errors.some((e) => e.code === 'INVALID_REVIEWER'));
  assert.ok(M.completeReview(s1.review, 'a').errors.some((e) => e.code === 'DUPLICATE_REVIEWER'));
});

test('E12-3. returnForChanges / cancelReview / restartReview', () => {
  const r = M.createReview({ workflow: NON_PARALLEL });
  const ret = M.returnForChanges(r, 'bob', { comments: 'fix' });
  assert.equal(ret.valid, true);
  assert.equal(ret.review.status, 'CHANGES_REQUESTED');
  assert.deepEqual(ret.review.returnedBy, ['bob']);
  assert.ok(M.returnForChanges(r, '').errors.some((e) => e.code === 'INVALID_REVIEWER'));
  // returning the same reviewer again is a no-op (uniqPush), still allowed while non-terminal
  const ret2 = M.returnForChanges(ret.review, 'bob');
  assert.deepEqual(ret2.review.returnedBy, ['bob']);
  // cancel
  const cancelled = M.cancelReview(r, { comments: 'stop' });
  assert.equal(cancelled.review.status, 'CANCELLED');
  assert.equal(M.cancelReview(cancelled.review).valid, false); // terminal → NOT_CANCELLABLE
  // return on a terminal review is rejected
  assert.ok(M.returnForChanges(cancelled.review, 'x').errors.some((e) => e.code === 'NOT_REVIEWABLE'));
  // restart clears review state
  const restarted = M.restartReview(cancelled.review);
  assert.equal(restarted.review.status, 'PENDING');
  assert.equal(restarted.review.currentStage, 1);
  assert.deepEqual(restarted.review.completedBy, []);
  assert.equal(restarted.review.decision, '');
});

test('E12-4. nextStage / previousStage: bounded', () => {
  assert.equal(M.nextStage({ currentStage: 1, totalStages: 3 }).currentStage, 2);
  assert.equal(M.nextStage({ currentStage: 3, totalStages: 3 }).currentStage, 3);
  assert.equal(M.previousStage({ currentStage: 2, totalStages: 3 }).currentStage, 1);
  assert.equal(M.previousStage({ currentStage: 1 }).currentStage, 1);
});

test('E12-5. canReview', () => {
  const r = M.createReview({ workflow: NON_PARALLEL });
  assert.equal(M.canReview(r, 'z'), true);
  assert.equal(M.canReview(r, ''), false);
  const done = M.completeReview(r, 'a').review;
  assert.equal(M.canReview(done, 'z'), false); // terminal
  assert.equal(M.canReview({ completedBy: ['z'], status: 'UNDER_REVIEW' }, 'z'), false); // duplicate
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E12-6. validateReview: shape, workflow, status, stages, reviewers, uniqueness, consistency', () => {
  assert.equal(M.validateReview({ status: 'PENDING', currentStage: 1, totalStages: 2, reviewers: ['a', 'b'] }).valid, true);
  const nonObj = M.validateReview(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_REVIEW');
  const codes = (a) => M.validateReview(a).errors.map((e) => e.code);
  const warns = (a) => M.validateReview(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'PENDING', workflow: 'MADEUP' }).includes('UNKNOWN_WORKFLOW'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  assert.ok(codes({ status: 'PENDING', currentStage: 1.5 }).includes('INVALID_STAGE'));
  assert.ok(codes({ status: 'PENDING', currentStage: 3, totalStages: 2 }).includes('STAGE_RANGE'));
  assert.ok(codes({ status: 'PENDING', reviewers: 'nope' }).includes('INVALID_REVIEWERS'));
  assert.ok(codes({ status: 'PENDING', reviewers: ['x', 'x'] }).includes('DUPLICATE_REVIEWER'));
  assert.ok(codes({ status: 'PENDING', completedBy: ['x', 'x'] }).includes('DUPLICATE_REVIEWER'));
  assert.ok(warns({ status: 'PENDING', completedBy: ['x'], returnedBy: ['x'] }).includes('DECISION_CONFLICT'));
  assert.ok(warns({ status: 'COMPLETED', decision: 'return' }).includes('DECISION_MISMATCH'));
  assert.equal(M.validateReview({ status: 'COMPLETED', decision: 'complete', currentStage: 2, totalStages: 2, reviewers: ['a'], completedBy: ['a'], returnedBy: ['b'] }).valid, true);
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E12-7. normalizeReview: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeReview({ status: 'PENDING', comments: '  c  ', reviewers: [' b ', 'a', 'a', ''], metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.comments, 'c');
  assert.deepEqual(n.reviewers, ['a', 'b']);
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E12-8. mergeReview: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeReview({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeReview({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeReview({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeReview({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeReview({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeReview({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeReview({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeReview({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeReview({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeReview({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeReview(5, { a: 1 }), { a: 1 });
});

test('E12-9. compareReview: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareReview({ status: 'PENDING', comments: 'x', metadata: { a: 1 }, same: 1 }, { status: 'COMPLETED', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['comments']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareReview(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareReview({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareReview({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E12-10. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, reviewers: ['x'] };
  const frozen = M.freezeReview(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.reviewers));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneReview(src).metadata, src.metadata);
  assert.deepEqual(M.cloneReview(5), {});
  assert.deepEqual(M.freezeReview(5), {});
  const s1 = M.generateReviewSnapshot(src);
  assert.equal(s1.schema, 'enterprise-review.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateReviewSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.review));
  assert.notEqual(s1.digest, M.generateReviewSnapshot({ status: 'COMPLETED' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E12-11. createHistory + listReviews: structure, coercion, reviewId variants', () => {
  const h = H.createHistory({ reviewId: 'R1', workflow: 'STANDARD', reviews: [{ decision: 'complete' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['reviewId', 'workflow', 'reviews', 'metadata', 'futureReserved']);
  assert.equal(h.reviewId, 'R1');
  assert.equal(H.listReviews(h).length, 1);
  assert.equal(H.createHistory({}).reviewId, null);
  assert.equal(H.createHistory({ reviewId: null }).reviewId, null);
  assert.equal(H.createHistory({ reviewId: 7 }).reviewId, 7);
  assert.equal(H.createHistory({}).workflow, 'NONE');
  assert.deepEqual(H.createHistory({ reviews: 'no', metadata: 5, futureReserved: 9 }).reviews, []);
});

test('E12-12. append / replace / remove / find', () => {
  const h = H.createHistory({ reviews: [{ decision: 'complete', timestamp: 't1' }] });
  const app = H.appendReview(h, { decision: 'return', timestamp: 't2' });
  assert.equal(app.reviews.length, 2);
  assert.equal(h.reviews.length, 1);
  const rep = H.replaceReview(app, 't1', { decision: 'cancel', timestamp: 't1' });
  assert.equal(rep.reviews.find((r) => r.decision === 'cancel') !== undefined, true);
  assert.equal(H.replaceReview(app, 'none', { decision: 'x' }).reviews.some((r) => r.decision === 'x'), false);
  const rem = H.removeReview(app, 't1');
  assert.equal(rem.reviews.length, 1);
  assert.equal(H.removeReview(app, null).reviews.length, 2);
  assert.equal(H.findReview(app, 't2').decision, 'return');
  assert.equal(H.findReview(app, 'nope'), null);
  assert.equal(H.findReview(app, null), null);
});

test('E12-13. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ reviews: [{ decision: 'complete', timestamp: '2026-01-01' }, { decision: 'complete', timestamp: '2026-03-01' }, { decision: 'return', timestamp: '2026-02-01' }] });
  assert.equal(H.findLatest(h).timestamp, '2026-03-01');
  assert.equal(H.findLatest({ reviews: [] }), null);
  assert.equal(H.findPrevious(h, '2026-02-01').timestamp, '2026-01-01');
  assert.equal(H.findPrevious(h, '2026-01-01'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, '2026-02-01').timestamp, '2026-03-01');
  assert.equal(H.findNext(h, '2026-03-01'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  const noTs = H.createHistory({ reviews: [{ reviewId: 'X', decision: 'complete' }, { reviewId: 'Y', decision: 'return' }] });
  assert.equal(H.findReview(noTs, 'X').reviewId, 'X');
  assert.equal(H.findLatest(noTs).reviewId, 'Y'); // index tiebreak, empty timestamps
});

test('E12-14. compareHistory / validateHistory: keys, duplicates, per-review, nested deepEqual', () => {
  const a = H.createHistory({ reviews: [{ decision: 'complete', timestamp: 't1' }, { decision: 'return', timestamp: 't2' }] });
  const b = H.createHistory({ reviews: [{ decision: 'complete', timestamp: 't1', comments: 'edited' }, { decision: 'complete', timestamp: 't3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['t3']);
  assert.deepEqual(d.removed, ['t2']);
  assert.deepEqual(d.modified, ['t1']);
  const same = { decision: 'complete', timestamp: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ reviews: [same, { decision: 'complete', timestamp: 'x', metadata: { a: 1 } }, { decision: 'complete', timestamp: 'y', completedBy: ['p'] }, { decision: 'complete', timestamp: 'z', completedBy: ['p'] }, { decision: 'complete', timestamp: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ reviews: [same, { decision: 'complete', timestamp: 'x', metadata: { b: 1 } }, { decision: 'complete', timestamp: 'y', completedBy: ['p', 'q'] }, { decision: 'complete', timestamp: 'z', completedBy: ['q'] }, { decision: 'complete', timestamp: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  // validation
  assert.equal(H.validateHistory({ reviews: [{ status: 'PENDING', timestamp: 't1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ reviews: 'no' }).errors.some((e) => e.code === 'INVALID_REVIEWS'));
  const dup = H.validateHistory({ reviews: [{ status: 'PENDING', timestamp: 't1' }, { status: 'PENDING', timestamp: 't1' }] });
  assert.deepEqual(dup.duplicateReviews, ['t1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_REVIEW'));
  const bubble = H.validateHistory({ reviews: [{ status: 'FOO', timestamp: 't1', workflow: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_WORKFLOW'));
  // a keyless raw review → reviewKey '' (pickString exhausts all fields)
  assert.ok(H.validateHistory({ reviews: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E12-15. normalizeHistory / clone / freeze: sorted, normalized, immutable, caller-safe', () => {
  const h = { reviewId: 'R', workflow: 'STANDARD', reviews: [{ decision: 'complete', timestamp: 't3' }, { decision: 'complete', timestamp: 't1' }, { decision: 'return', timestamp: 't2' }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(n.reviews.map((r) => r.timestamp), ['t1', 't2', 't3']);
  assert.deepEqual(Object.keys(n), ['reviewId', 'workflow', 'reviews', 'metadata', 'futureReserved']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.reviews) && Object.isFrozen(frozen.reviews[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).reviews, h.reviews);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E12-16. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['canReview', 'cancelReview', 'cloneReview', 'compareReview', 'completeReview', 'createReview', 'freezeReview', 'generateReviewSnapshot', 'mergeReview', 'nextStage', 'normalizeReview', 'previousStage', 'restartReview', 'returnForChanges', 'validateReview']);
  assert.deepEqual(Object.keys(H).sort(), ['appendReview', 'cloneHistory', 'compareHistory', 'createHistory', 'findLatest', 'findNext', 'findPrevious', 'findReview', 'freezeHistory', 'listReviews', 'normalizeHistory', 'removeReview', 'replaceReview', 'validateHistory']);
});

test('E12-17. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { reviews: 5 }, { currentStage: 'x' }];
  for (const a of hostile) {
    for (const fn of ['createReview', 'validateReview', 'normalizeReview', 'cloneReview', 'freezeReview', 'generateReviewSnapshot', 'nextStage', 'previousStage', 'cancelReview', 'restartReview']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    for (const fn of ['completeReview', 'returnForChanges']) noThrow(() => M[fn](a, a, a), `M.${fn}`);
    noThrow(() => M.canReview(a, a), 'M.canReview');
    noThrow(() => M.mergeReview(a, a, a), 'M.mergeReview');
    noThrow(() => M.compareReview(a, a), 'M.compareReview');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listReviews']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendReview', 'removeReview', 'findReview', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceReview(a, a, a), 'H.replaceReview');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E12-18. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ workflow: 'STANDARD', status: 'PENDING', completedBy: Object.freeze(['a']), metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createReview(input), 'create frozen');
  noThrow(() => M.completeReview(input, 'b'), 'complete frozen');
  noThrow(() => M.normalizeReview(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
  assert.deepEqual(M.createReview({ status: 'PENDING' }), M.createReview({ status: 'PENDING' }));
  const a = M.createReview({ status: 'PENDING' });
  const b = M.createReview({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E12-19. review modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-review-manager.js', 'document-review-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E12-20. review engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
