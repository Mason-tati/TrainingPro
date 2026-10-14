// WP-26 · Phase 5 — Enterprise Document Approval service tests (business rules; ephemeral in-memory DB).
// Covers version existence validation (via injected version repo), level sequencing, single active
// approval per level, approve/reject/delegate/escalate, approval completion, and never-throw.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const AMig = require(path.join(EDIR, 'enterprise-document-approval-migration.js'));
const ARepo = require(path.join(EDIR, 'enterprise-document-approval-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-approval-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findPending', 'findApproved', 'findRejected', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await AMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const svc = new Service(new ARepo(db), verRepo);
  return { db, svc, verId: ver.version.id };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } });
}

// ---- construction ----

test('W26A-SVC-1. constructor validates the approval repo AND requires a version repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected version repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected version repository/);
});

// ---- create: validation ----

test('W26A-SVC-2. createApproval requires an existing version', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createApproval(null)).code, 'VALIDATION');
  assert.equal((await svc.createApproval({ approverId: 1 })).code, 'VALIDATION', 'missing versionId (undefined)');
  assert.equal((await svc.createApproval({ documentVersionId: null, approverId: 1 })).code, 'VALIDATION', 'null versionId');
  assert.equal((await svc.createApproval({ documentVersionId: 9999, approverId: 1 })).code, 'VALIDATION', 'unknown version');
  db.close();
});

test('W26A-SVC-3. createApproval validates level / approver / status', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 0, approverId: 1 })).code, 'VALIDATION');
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 1.5, approverId: 1 })).code, 'VALIDATION');
  assert.equal((await svc.createApproval({ documentVersionId: verId, approverId: 0 })).code, 'VALIDATION', 'approver required');
  assert.equal((await svc.createApproval({ documentVersionId: verId })).code, 'VALIDATION', 'approver missing');
  assert.equal((await svc.createApproval({ documentVersionId: verId, approverId: 1, approvalStatus: 'NOPE' })).code, 'VALIDATION');
  db.close();
});

test('W26A-SVC-4. first-level approval is created PENDING with a requestedDate', async () => {
  const { db, svc, verId } = await freshService();
  const a = (await svc.createApproval({ documentVersionId: verId, approverId: 10, approverRole: 'Manager' })).approval;
  assert.equal(a.approvalLevel, 1);
  assert.equal(a.approvalStatus, 'PENDING');
  assert.ok(a.requestedDate);
  assert.equal(a.escalated, 0);
  db.close();
});

test('W26A-SVC-5. single active approval per level (duplicate → CONFLICT)', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 1, approverId: 10 })).ok, true);
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 1, approverId: 11 })).code, 'CONFLICT');
  db.close();
});

// ---- level sequencing ----

test('W26A-SVC-6. level 2 is rejected when level 1 does not exist', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 2, approverId: 20 })).code, 'VALIDATION');
  db.close();
});

test('W26A-SVC-7. level 2 is rejected while level 1 is still pending; allowed once level 1 is approved', async () => {
  const { db, svc, verId } = await freshService();
  const l1 = await svc.createApproval({ documentVersionId: verId, approvalLevel: 1, approverId: 10 });
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 2, approverId: 20 })).code, 'VALIDATION', 'L1 pending');
  await svc.approveApproval(l1.approval.id);
  assert.equal((await svc.createApproval({ documentVersionId: verId, approvalLevel: 2, approverId: 20 })).ok, true, 'L1 approved → L2 allowed');
  db.close();
});

// ---- read ----

test('W26A-SVC-8. getApproval found / NOT_FOUND', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  assert.equal((await svc.getApproval(created.approval.id)).ok, true);
  assert.equal((await svc.getApproval(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26A-SVC-9. listVersionApprovals and pendingApprovals', async () => {
  const { db, svc, verId } = await freshService();
  const l1 = await svc.createApproval({ documentVersionId: verId, approvalLevel: 1, approverId: 10 });
  await svc.approveApproval(l1.approval.id);
  await svc.createApproval({ documentVersionId: verId, approvalLevel: 2, approverId: 20 });
  assert.equal((await svc.listVersionApprovals(verId)).approvals.length, 2);
  assert.equal((await svc.pendingApprovals()).approvals.length, 1, 'only L2 pending');
  db.close();
});

// ---- update ----

test('W26A-SVC-10. updateApproval NOT_FOUND / content update / non-object no-op', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.updateApproval(4242, { approverRole: 'x' })).code, 'NOT_FOUND');
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  const upd = await svc.updateApproval(id, { approverRole: 'Director', approvalComments: 'looks good', dueDate: '2026-08-01' });
  assert.equal(upd.approval.approverRole, 'Director');
  assert.equal(upd.approval.approvalComments, 'looks good');
  assert.equal((await svc.updateApproval(id, null)).ok, true);
  db.close();
});

// ---- decisions: approve / reject / delegate / escalate ----

test('W26A-SVC-11. approveApproval: NOT_FOUND / success / already-decided', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.approveApproval(9999)).code, 'NOT_FOUND');
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  const ok = await svc.approveApproval(id);
  assert.equal(ok.approval.approvalStatus, 'APPROVED');
  assert.ok(ok.approval.approvedDate);
  assert.equal((await svc.approveApproval(id)).code, 'VALIDATION', 'already approved');
  db.close();
});

test('W26A-SVC-12. rejectApproval: NOT_FOUND / success / already-decided', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.rejectApproval(9999)).code, 'NOT_FOUND');
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  const rej = await svc.rejectApproval(id);
  assert.equal(rej.approval.approvalStatus, 'REJECTED');
  assert.ok(rej.approval.rejectedDate);
  assert.equal((await svc.rejectApproval(id)).code, 'VALIDATION', 'cannot reject an already-decided approval');
  assert.equal((await svc.approveApproval(id)).code, 'VALIDATION', 'cannot approve a rejected approval');
  db.close();
});

test('W26A-SVC-13. delegateApproval: NOT_FOUND / invalid target / success / decided', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.delegateApproval(9999, 5)).code, 'NOT_FOUND');
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  assert.equal((await svc.delegateApproval(id, 0)).code, 'VALIDATION', 'invalid delegatedTo');
  const del = await svc.delegateApproval(id, 25);
  assert.equal(del.approval.approvalStatus, 'DELEGATED');
  assert.equal(del.approval.delegatedTo, 25);
  await svc.approveApproval(id);
  assert.equal((await svc.delegateApproval(id, 30)).code, 'VALIDATION', 'cannot delegate a decided approval');
  db.close();
});

test('W26A-SVC-14. escalateApproval: NOT_FOUND / success / decided', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.escalateApproval(9999)).code, 'NOT_FOUND');
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  const esc = await svc.escalateApproval(id);
  assert.equal(esc.approval.approvalStatus, 'ESCALATED');
  assert.equal(esc.approval.escalated, 1);
  assert.ok(esc.approval.escalatedDate);
  await svc.rejectApproval(id);
  assert.equal((await svc.escalateApproval(id)).code, 'VALIDATION', 'cannot escalate a decided approval');
  db.close();
});

// ---- completion logic ----

test('W26A-SVC-15. getApprovalCompletion: empty, partial, and fully-approved', async () => {
  const { db, svc, verId } = await freshService();
  assert.deepEqual(await svc.getApprovalCompletion(verId), { ok: true, complete: false, total: 0, approved: 0 });
  const l1 = await svc.createApproval({ documentVersionId: verId, approvalLevel: 1, approverId: 10 });
  await svc.approveApproval(l1.approval.id);
  const l2 = await svc.createApproval({ documentVersionId: verId, approvalLevel: 2, approverId: 20 });
  const partial = await svc.getApprovalCompletion(verId);
  assert.deepEqual(partial, { ok: true, complete: false, total: 2, approved: 1 });
  await svc.approveApproval(l2.approval.id);
  const full = await svc.getApprovalCompletion(verId);
  assert.deepEqual(full, { ok: true, complete: true, total: 2, approved: 2 });
  db.close();
});

// ---- lifecycle ----

test('W26A-SVC-16. archiveApproval success / NOT_FOUND / already-archived', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  assert.equal((await svc.archiveApproval(id)).approval.archived, 1);
  assert.equal((await svc.archiveApproval(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveApproval(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26A-SVC-17. deleteApproval success then NOT_FOUND on re-delete', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  assert.equal((await svc.deleteApproval(id)).ok, true);
  assert.equal((await svc.deleteApproval(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26A-SVC-18. restoreApproval restores a soft-deleted approval; NOT_FOUND for unknown id', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createApproval({ documentVersionId: verId, approverId: 10 });
  const id = created.approval.id;
  await svc.deleteApproval(id);
  const restored = await svc.restoreApproval(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.approval.deleted, 0);
  assert.equal((await svc.restoreApproval(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26A-SVC-19. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getApproval(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26A-SVC-20. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findByVersion', 'boom-string');
  const r = await svc.createApproval({ documentVersionId: 1, approverId: 1 });
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
