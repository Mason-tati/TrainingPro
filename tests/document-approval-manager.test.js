// WP-18 · E11 — Enterprise Document Approval Engine Foundation tests.
// Exhaustively exercises the approval manager (create/approve/reject/delegate/withdraw/
// restart/nextStage/previousStage/can*/validate/normalize/clone/freeze/merge/compare/
// snapshot) and the approval history (create/append/replace/remove/find/latest/previous/
// next/list/compare/validate/normalize/clone/freeze). Covers single + multi-stage approval,
// delegation, withdrawal, restart, hostile inputs, never-throw, determinism, immutability,
// copy-on-read, futureReserved, export surface, and unwired. Pure in-memory.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-approval-manager.js'));
const H = require(path.join(EDIR, 'document-approval-history.js'));
const APW = require(path.join(ROOT, 'lib', 'document', 'document-approval-workflows.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const AP_FIELDS = ['approvalId', 'workflow', 'status', 'currentStage', 'totalStages', 'approvers', 'approvedBy', 'rejectedBy', 'delegatedBy', 'delegateTo', 'decision', 'reason', 'timestamp', 'metadata', 'futureReserved'];
// a workflow that permits delegation, and one with allowSelfApproval
const DELEGATING = APW.DOCUMENT_APPROVAL_WORKFLOW_IDS.find((id) => APW.getDocumentApprovalWorkflow(id).allowDelegation === true);
const SELF_OK = APW.DOCUMENT_APPROVAL_WORKFLOW_IDS.find((id) => APW.getDocumentApprovalWorkflow(id).allowSelfApproval === true);

// ---------------------------------------------------------------------------
// manager: create
// ---------------------------------------------------------------------------

test('E11-1. createApproval: full structure, coercion, defaults', () => {
  const a = M.createApproval();
  assert.deepEqual(Object.keys(a), AP_FIELDS);
  assert.equal(a.status, 'PENDING');
  assert.equal(a.workflow, 'NONE');
  assert.equal(a.currentStage, 1);
  assert.equal(a.totalStages, 1);
  assert.deepEqual(a.approvedBy, []);
  assert.deepEqual(a.futureReserved, []);
  const c = M.createApproval({ workflow: 'SUPERVISOR_APPROVAL', status: 'UNDER_REVIEW', currentStage: 2.9, totalStages: 'x', reason: 5, timestamp: '', metadata: [1], futureReserved: 'no', approvedBy: ['a'] });
  assert.equal(c.currentStage, 2); // float truncated
  assert.equal(c.totalStages, 1); // non-number → 0 → default 1
  assert.equal(c.reason, '5');
  assert.equal(c.timestamp, null);
  assert.deepEqual(c.metadata, {});
  assert.deepEqual(c.futureReserved, []);
  assert.deepEqual(c.approvedBy, ['a']);
  assert.equal(M.createApproval({}, { workflow: 'FORM_APPROVAL' }).workflow, 'FORM_APPROVAL'); // option
  assert.equal(M.createApproval({}, { defaultStatus: 'DELEGATED' }).status, 'DELEGATED');
});

// ---------------------------------------------------------------------------
// manager: decisions
// ---------------------------------------------------------------------------

test('E11-2. approve: single-stage completes; multi-stage progresses; invalid cases', () => {
  const single = M.createApproval({ workflow: 'SUPERVISOR_APPROVAL' });
  const ap = M.approve(single, 'alice', { reason: 'ok', timestamp: '2026-01-01' });
  assert.equal(ap.valid, true);
  assert.equal(ap.approval.status, 'APPROVED'); // 1 stage, minApprovers 1 → complete
  assert.deepEqual(ap.approval.approvedBy, ['alice']);
  assert.equal(ap.approval.decision, 'approve');
  assert.equal(ap.approval.reason, 'ok');
  // multi-stage progression
  const multi = M.createApproval({ workflow: 'SUPERVISOR_APPROVAL', totalStages: 2 });
  const s1 = M.approve(multi, 'a');
  assert.equal(s1.approval.status, 'UNDER_REVIEW');
  assert.equal(s1.approval.currentStage, 1);
  const s2 = M.approve(s1.approval, 'b');
  assert.equal(s2.approval.status, 'APPROVED');
  assert.equal(s2.approval.currentStage, 2);
  // invalid: terminal, invalid approver, duplicate
  assert.equal(M.approve(ap.approval, 'x').valid, false); // already APPROVED → NOT_APPROVABLE
  assert.ok(M.approve(single, '  ').errors.some((e) => e.code === 'INVALID_APPROVER'));
  assert.ok(M.approve(s1.approval, 'a').errors.some((e) => e.code === 'DUPLICATE_APPROVER'));
  // minApprovers 0 (NONE) → treated as 1
  assert.equal(M.approve(M.createApproval({ workflow: 'NONE' }), 'z').approval.status, 'APPROVED');
});

test('E11-3. approve: self-approval gating', () => {
  // a workflow that disallows self-approval → self:true rejected
  const strict = M.createApproval({ workflow: 'SUPERVISOR_APPROVAL' });
  assert.ok(M.approve(strict, 'me', { self: true }).errors.some((e) => e.code === 'SELF_APPROVAL_NOT_ALLOWED'));
  assert.equal(M.approve(strict, 'me', { self: false }).valid, true);
  // a workflow permitting self-approval → self:true allowed
  if (SELF_OK) assert.equal(M.approve(M.createApproval({ workflow: SELF_OK }), 'me', { self: true }).valid, true);
});

test('E11-4. reject / withdraw / restart', () => {
  const a = M.createApproval({ workflow: 'SUPERVISOR_APPROVAL' });
  const r = M.reject(a, 'bob', { reason: 'no' });
  assert.equal(r.valid, true);
  assert.equal(r.approval.status, 'REJECTED');
  assert.deepEqual(r.approval.rejectedBy, ['bob']);
  assert.equal(M.reject(r.approval, 'x').valid, false); // terminal
  assert.ok(M.reject(a, '').errors.some((e) => e.code === 'INVALID_REJECTOR'));
  // withdraw
  const w = M.withdraw(a, { reason: 'stop' });
  assert.equal(w.approval.status, 'WITHDRAWN');
  assert.equal(M.withdraw(r.approval).valid, false); // terminal → NOT_WITHDRAWABLE
  // restart clears decision state
  const restarted = M.restart(r.approval);
  assert.equal(restarted.approval.status, 'PENDING');
  assert.equal(restarted.approval.currentStage, 1);
  assert.deepEqual(restarted.approval.rejectedBy, []);
  assert.equal(restarted.approval.decision, '');
});

test('E11-5. delegate: permitted vs not; invalid delegator/delegate', () => {
  const none = M.createApproval({ workflow: 'NONE' }); // NONE has allowDelegation false
  assert.ok(M.delegate(none, 'x', 'y').errors.some((e) => e.code === 'DELEGATION_NOT_ALLOWED'));
  const d = M.createApproval({ workflow: DELEGATING });
  const del = M.delegate(d, 'alice', 'bob', { timestamp: '2026-01-01' });
  assert.equal(del.valid, true);
  assert.equal(del.approval.status, 'DELEGATED');
  assert.deepEqual(del.approval.delegatedBy, ['alice']);
  assert.deepEqual(del.approval.delegateTo, ['bob']);
  assert.ok(M.delegate(d, '', 'bob').errors.some((e) => e.code === 'INVALID_DELEGATOR'));
  assert.ok(M.delegate(d, 'alice', '').errors.some((e) => e.code === 'INVALID_DELEGATE'));
  // delegating the same person again does not duplicate (uniqPush no-op)
  const del2 = M.delegate(del.approval, 'alice', 'bob');
  assert.deepEqual(del2.approval.delegatedBy, ['alice']);
  assert.deepEqual(del2.approval.delegateTo, ['bob']);
  // delegate on terminal → NOT_APPROVABLE
  const approved = M.approve(M.createApproval({ workflow: DELEGATING }), 'a').approval;
  assert.ok(M.delegate(approved, 'x', 'y').errors.some((e) => e.code === 'NOT_APPROVABLE'));
});

test('E11-6. nextStage / previousStage: bounded', () => {
  assert.equal(M.nextStage({ currentStage: 1, totalStages: 3 }).currentStage, 2);
  assert.equal(M.nextStage({ currentStage: 3, totalStages: 3 }).currentStage, 3); // capped
  assert.equal(M.previousStage({ currentStage: 2, totalStages: 3 }).currentStage, 1);
  assert.equal(M.previousStage({ currentStage: 1 }).currentStage, 1); // floored
});

test('E11-7. canApprove / canReject / canDelegate', () => {
  const a = M.createApproval({ workflow: DELEGATING });
  assert.equal(M.canApprove(a, 'z'), true);
  assert.equal(M.canApprove(a, ''), false);
  assert.equal(M.canReject(a, 'z'), true);
  assert.equal(M.canReject(a, ''), false);
  assert.equal(M.canDelegate(a, 'x', 'y'), true);
  assert.equal(M.canDelegate(M.createApproval({ workflow: 'NONE' }), 'x', 'y'), false);
  const approved = M.approve(a, 'a').approval;
  assert.equal(M.canApprove(approved, 'z'), false); // terminal
  assert.equal(M.canReject(approved, 'z'), false);
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E11-8. validateApproval: shape, workflow, status, stages, uniqueness, consistency', () => {
  assert.equal(M.validateApproval({ status: 'PENDING', currentStage: 1, totalStages: 2 }).valid, true);
  const nonObj = M.validateApproval(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_APPROVAL');
  const codes = (a) => M.validateApproval(a).errors.map((e) => e.code);
  const warns = (a) => M.validateApproval(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'PENDING', workflow: 'MADEUP' }).includes('UNKNOWN_WORKFLOW'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  assert.ok(codes({ status: 'PENDING', currentStage: 1.5 }).includes('INVALID_STAGE'));
  assert.ok(codes({ status: 'PENDING', currentStage: 3, totalStages: 2 }).includes('STAGE_RANGE'));
  assert.ok(codes({ status: 'PENDING', approvedBy: ['x', 'x'] }).includes('DUPLICATE_APPROVER'));
  assert.ok(warns({ status: 'PENDING', approvedBy: ['x'], rejectedBy: ['x'] }).includes('DECISION_CONFLICT'));
  assert.ok(warns({ status: 'APPROVED', decision: 'reject' }).includes('DECISION_MISMATCH'));
  assert.ok(warns({ status: 'DELEGATED', delegateTo: [] }).includes('MISSING_DELEGATE'));
  // valid stages + non-conflicting arrays produce no such errors
  assert.equal(M.validateApproval({ status: 'COMPLETED', decision: 'approve', currentStage: 2, totalStages: 2, approvedBy: ['a', 'b'], rejectedBy: ['c'] }).valid, true);
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E11-9. normalizeApproval: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeApproval({ status: 'PENDING', reason: '  r  ', approvers: [' b ', 'a', 'a', ''], metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.reason, 'r');
  assert.deepEqual(n.approvers, ['a', 'b']); // trimmed, deduped, sorted, '' dropped
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E11-10. mergeApproval: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeApproval({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeApproval({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeApproval({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeApproval({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeApproval({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeApproval({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeApproval({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeApproval({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeApproval({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeApproval({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeApproval(5, { a: 1 }), { a: 1 });
});

test('E11-11. compareApproval: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareApproval({ status: 'PENDING', reason: 'x', metadata: { a: 1 }, same: 1 }, { status: 'APPROVED', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['reason']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareApproval(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareApproval({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareApproval({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E11-12. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, approvers: ['x'] };
  const frozen = M.freezeApproval(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.approvers));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneApproval(src).metadata, src.metadata);
  assert.deepEqual(M.cloneApproval(5), {});
  assert.deepEqual(M.freezeApproval(5), {});
  const s1 = M.generateApprovalSnapshot(src);
  assert.equal(s1.schema, 'enterprise-approval.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateApprovalSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.approval));
  assert.notEqual(s1.digest, M.generateApprovalSnapshot({ status: 'APPROVED' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E11-13. createHistory + listDecisions: structure, coercion, approvalId variants', () => {
  const h = H.createHistory({ approvalId: 'A1', workflow: 'SUPERVISOR_APPROVAL', decisions: [{ decision: 'approve' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['approvalId', 'workflow', 'decisions', 'metadata', 'futureReserved']);
  assert.equal(h.approvalId, 'A1');
  assert.equal(H.listDecisions(h).length, 1);
  assert.equal(H.createHistory({}).approvalId, null);
  assert.equal(H.createHistory({ approvalId: null }).approvalId, null);
  assert.equal(H.createHistory({ approvalId: 7 }).approvalId, 7);
  assert.equal(H.createHistory({}).workflow, 'NONE');
  assert.deepEqual(H.createHistory({ decisions: 'no', metadata: 5, futureReserved: 9 }).decisions, []);
});

test('E11-14. append / replace / remove / find', () => {
  const h = H.createHistory({ decisions: [{ decision: 'approve', timestamp: 't1' }] });
  const app = H.appendDecision(h, { decision: 'reject', timestamp: 't2' });
  assert.equal(app.decisions.length, 2);
  assert.equal(h.decisions.length, 1);
  const rep = H.replaceDecision(app, 't1', { decision: 'withdraw', timestamp: 't1' });
  assert.equal(rep.decisions.find((d) => d.decision === 'withdraw') !== undefined, true);
  assert.equal(H.replaceDecision(app, 'none', { decision: 'x' }).decisions.some((d) => d.decision === 'x'), false);
  const rem = H.removeDecision(app, 't1');
  assert.equal(rem.decisions.length, 1);
  assert.equal(H.removeDecision(app, null).decisions.length, 2);
  assert.equal(H.findDecision(app, 't2').decision, 'reject');
  assert.equal(H.findDecision(app, 'nope'), null);
  assert.equal(H.findDecision(app, null), null);
});

test('E11-15. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ decisions: [{ decision: 'approve', timestamp: '2026-01-01' }, { decision: 'approve', timestamp: '2026-03-01' }, { decision: 'reject', timestamp: '2026-02-01' }] });
  assert.equal(H.findLatest(h).timestamp, '2026-03-01');
  assert.equal(H.findLatest({ decisions: [] }), null);
  assert.equal(H.findPrevious(h, '2026-02-01').timestamp, '2026-01-01');
  assert.equal(H.findPrevious(h, '2026-01-01'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, '2026-02-01').timestamp, '2026-03-01');
  assert.equal(H.findNext(h, '2026-03-01'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  // key fallback (no timestamp → approvalId/decision) + no-timestamp ordering
  const noTs = H.createHistory({ decisions: [{ approvalId: 'X', decision: 'approve' }, { approvalId: 'Y', decision: 'reject' }] });
  assert.equal(H.findDecision(noTs, 'X').approvalId, 'X');
  assert.equal(H.findLatest(noTs).approvalId, 'Y'); // index tiebreak with empty timestamps
});

test('E11-16. compareHistory / validateHistory: keys, duplicates, per-decision, nested deepEqual', () => {
  const a = H.createHistory({ decisions: [{ decision: 'approve', timestamp: 't1' }, { decision: 'reject', timestamp: 't2' }] });
  const b = H.createHistory({ decisions: [{ decision: 'approve', timestamp: 't1', reason: 'edited' }, { decision: 'approve', timestamp: 't3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['t3']);
  assert.deepEqual(d.removed, ['t2']);
  assert.deepEqual(d.modified, ['t1']);
  // deepEqual structural mismatches
  const same = { decision: 'approve', timestamp: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ decisions: [same, { decision: 'approve', timestamp: 'x', metadata: { a: 1 } }, { decision: 'approve', timestamp: 'y', approvedBy: ['p'] }, { decision: 'approve', timestamp: 'z', approvedBy: ['p'] }, { decision: 'approve', timestamp: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ decisions: [same, { decision: 'approve', timestamp: 'x', metadata: { b: 1 } }, { decision: 'approve', timestamp: 'y', approvedBy: ['p', 'q'] }, { decision: 'approve', timestamp: 'z', approvedBy: ['q'] }, { decision: 'approve', timestamp: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  // validation
  assert.equal(H.validateHistory({ decisions: [{ status: 'PENDING', timestamp: 't1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ decisions: 'no' }).errors.some((e) => e.code === 'INVALID_DECISIONS'));
  const dup = H.validateHistory({ decisions: [{ status: 'PENDING', timestamp: 't1' }, { status: 'PENDING', timestamp: 't1' }] });
  assert.deepEqual(dup.duplicateDecisions, ['t1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_DECISION'));
  // per-decision error + warning bubble up
  const bubble = H.validateHistory({ decisions: [{ status: 'FOO', timestamp: 't1', workflow: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_WORKFLOW'));
  // a keyless raw decision → decisionKey '' (pickString exhausts all fields)
  assert.ok(H.validateHistory({ decisions: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E11-17. normalizeHistory / clone / freeze: sorted, normalized, immutable, caller-safe', () => {
  const h = { approvalId: 'A', workflow: 'SUPERVISOR_APPROVAL', decisions: [{ decision: 'approve', timestamp: 't3' }, { decision: 'approve', timestamp: 't1' }, { decision: 'reject', timestamp: 't2' }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(n.decisions.map((d) => d.timestamp), ['t1', 't2', 't3']);
  assert.deepEqual(Object.keys(n), ['approvalId', 'workflow', 'decisions', 'metadata', 'futureReserved']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.decisions) && Object.isFrozen(frozen.decisions[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).decisions, h.decisions);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E11-18. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['approve', 'canApprove', 'canDelegate', 'canReject', 'cloneApproval', 'compareApproval', 'createApproval', 'delegate', 'freezeApproval', 'generateApprovalSnapshot', 'mergeApproval', 'nextStage', 'normalizeApproval', 'previousStage', 'reject', 'restart', 'validateApproval', 'withdraw']);
  assert.deepEqual(Object.keys(H).sort(), ['appendDecision', 'cloneHistory', 'compareHistory', 'createHistory', 'findDecision', 'findLatest', 'findNext', 'findPrevious', 'freezeHistory', 'listDecisions', 'normalizeHistory', 'removeDecision', 'replaceDecision', 'validateHistory']);
});

test('E11-19. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { decisions: 5 }, { currentStage: 'x' }];
  for (const a of hostile) {
    for (const fn of ['createApproval', 'validateApproval', 'normalizeApproval', 'cloneApproval', 'freezeApproval', 'generateApprovalSnapshot', 'nextStage', 'previousStage', 'withdraw', 'restart']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    for (const fn of ['approve', 'reject']) noThrow(() => M[fn](a, a, a), `M.${fn}`);
    noThrow(() => M.delegate(a, a, a, a), 'M.delegate');
    noThrow(() => M.canApprove(a, a, a), 'M.canApprove');
    noThrow(() => M.canReject(a, a), 'M.canReject');
    noThrow(() => M.canDelegate(a, a, a), 'M.canDelegate');
    noThrow(() => M.mergeApproval(a, a, a), 'M.mergeApproval');
    noThrow(() => M.compareApproval(a, a), 'M.compareApproval');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listDecisions']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendDecision', 'removeDecision', 'findDecision', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceDecision(a, a, a), 'H.replaceDecision');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E11-20. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ workflow: 'SUPERVISOR_APPROVAL', status: 'PENDING', approvedBy: Object.freeze(['a']), metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createApproval(input), 'create frozen');
  noThrow(() => M.approve(input, 'b'), 'approve frozen');
  noThrow(() => M.normalizeApproval(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap); // unchanged
  assert.deepEqual(M.createApproval({ status: 'PENDING' }), M.createApproval({ status: 'PENDING' }));
  const a = M.createApproval({ status: 'PENDING' });
  const b = M.createApproval({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved); // fresh arrays
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E11-21. approval modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-approval-manager.js', 'document-approval-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E11-22. approval engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
