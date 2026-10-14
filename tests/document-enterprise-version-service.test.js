// WP-26 · Phase 4 — Enterprise Document Version service tests (business rules; ephemeral in-memory DB).
// Covers document existence validation (via injected doc-core repository), version uniqueness,
// major/minor sequencing, current-version + supersede logic, approval-status validation, archive/
// restore/delete, metadata, and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByDocument', 'findCurrent', 'findVersion', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const docRepo = new DRepo(db);
  const docSvc = new DSvc(docRepo, new FRepo(db));
  const svc = new Service(new VRepo(db), docRepo);
  const doc = await docSvc.createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  return { db, svc, docId: doc.document.id, docSvc };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } });
}

// ---- construction ----

test('W26V-SVC-1. constructor validates the version repo AND requires a document repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected document repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected document repository/);
});

// ---- create: validation ----

test('W26V-SVC-2. createVersion requires an existing document', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createVersion(null)).code, 'VALIDATION');
  assert.equal((await svc.createVersion({})).code, 'VALIDATION', 'missing documentId');
  assert.equal((await svc.createVersion({ documentId: 9999 })).code, 'VALIDATION', 'unknown document');
  db.close();
});

test('W26V-SVC-3. createVersion validates major/minor/approvalStatus/metadata', async () => {
  const { db, svc, docId } = await freshService();
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 0 })).code, 'VALIDATION');
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 1.5 })).code, 'VALIDATION');
  assert.equal((await svc.createVersion({ documentId: docId, minorVersion: -1 })).code, 'VALIDATION');
  assert.equal((await svc.createVersion({ documentId: docId, minorVersion: 1.2 })).code, 'VALIDATION');
  assert.equal((await svc.createVersion({ documentId: docId, approvalStatus: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.createVersion({ documentId: docId, metadata: 'no' })).code, 'VALIDATION');
  db.close();
});

test('W26V-SVC-4. first version defaults to 1.0 / DRAFT and becomes current', async () => {
  const { db, svc, docId } = await freshService();
  const v = (await svc.createVersion({ documentId: docId, changeSummary: 'init' })).version;
  assert.equal(v.versionNumber, '1.0');
  assert.equal(v.majorVersion, 1);
  assert.equal(v.minorVersion, 0);
  assert.equal(v.approvalStatus, 'DRAFT');
  assert.equal(v.supersededDate, null);
  assert.equal((await svc.getCurrentVersion(docId)).version.id, v.id, 'first version is current');
  db.close();
});

test('W26V-SVC-5. version numbers are unique per document', async () => {
  const { db, svc, docId } = await freshService();
  assert.equal((await svc.createVersion({ documentId: docId })).ok, true);
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 })).code, 'CONFLICT');
  db.close();
});

// ---- sequencing (covers every isGreaterVersion branch) ----

test('W26V-SVC-6. sequencing: minor then major bumps are accepted (1.0 → 1.1 → 2.0)', async () => {
  const { db, svc, docId } = await freshService();
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 })).ok, true);
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 1 })).ok, true, 'minor bump');
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 2, minorVersion: 0 })).ok, true, 'major bump');
  db.close();
});

test('W26V-SVC-7. sequencing: a lower major is rejected', async () => {
  const { db, svc, docId } = await freshService();
  await svc.createVersion({ documentId: docId, majorVersion: 2, minorVersion: 0 });
  const r = await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 5 });
  assert.equal(r.code, 'VALIDATION', 'lower major than latest');
  db.close();
});

test('W26V-SVC-8. sequencing: same major with a lower/equal minor is rejected', async () => {
  const { db, svc, docId } = await freshService();
  await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 });
  await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 5 });
  const r = await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 3 });
  assert.equal(r.code, 'VALIDATION', 'lower minor than latest 1.5');
  db.close();
});

// ---- current version + supersede ----

test('W26V-SVC-9. creating a newer version supersedes the previous current version', async () => {
  const { db, svc, docId } = await freshService();
  const v1 = (await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 })).version;
  await svc.createVersion({ documentId: docId, majorVersion: 2, minorVersion: 0 });
  const v1after = (await svc.getVersion(v1.id)).version;
  assert.ok(v1after.supersededDate, 'previous version now has a supersededDate');
  assert.equal(v1after.approvalStatus, 'SUPERSEDED');
  assert.equal((await svc.getCurrentVersion(docId)).version.versionNumber, '2.0');
  db.close();
});

test('W26V-SVC-10. getCurrentVersion NOT_FOUND when no versions exist', async () => {
  const { db, svc, docId } = await freshService();
  assert.equal((await svc.getCurrentVersion(docId)).code, 'NOT_FOUND');
  db.close();
});

test('W26V-SVC-11. createVersion (full) persists fields + parses metadata; metadataJson string accepted', async () => {
  const { db, svc, docId } = await freshService();
  const v = (await svc.createVersion({
    documentId: docId, majorVersion: 3, minorVersion: 2, changeSummary: 'c', authorId: 4, approvalStatus: 'PENDING',
    approvedBy: 9, approvedDate: '2026-01-01', effectiveDate: '2026-02-01', fileName: 'f.pdf', fileExtension: 'pdf',
    mimeType: 'application/pdf', fileSize: 99, checksum: 'sha', storagePath: '/s/f', metadata: { a: 1 },
  })).version;
  assert.equal(v.versionNumber, '3.2');
  assert.equal(v.fileSize, 99);
  assert.deepEqual(v.metadata, { a: 1 });
  const raw = (await svc.createVersion({ documentId: docId, majorVersion: 4, metadataJson: '{"x":1}' })).version;
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- read ----

test('W26V-SVC-12. getVersion found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc, docId } = await freshService();
  const created = await svc.createVersion({ documentId: docId });
  assert.equal((await svc.getVersion(created.version.id)).ok, true);
  assert.equal((await svc.getVersion(9999)).code, 'NOT_FOUND');
  const repo = new VRepo(db);
  const bad = await repo.create({ documentId: docId, majorVersion: 9, minorVersion: 9, versionNumber: '9.9', metadataJson: '{oops' });
  assert.equal((await svc.getVersion(bad.id)).version.metadata, null);
  db.close();
});

test('W26V-SVC-13. listVersions returns all versions for a document', async () => {
  const { db, svc, docId } = await freshService();
  await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 });
  await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 1 });
  const list = await svc.listVersions(docId);
  assert.equal(list.versions.length, 2);
  assert.deepEqual(list.versions.map((v) => v.versionNumber), ['1.0', '1.1']);
  db.close();
});

// ---- update / approval ----

test('W26V-SVC-14. updateVersion NOT_FOUND / validation / approval success', async () => {
  const { db, svc, docId } = await freshService();
  assert.equal((await svc.updateVersion(4242, { changeSummary: 'x' })).code, 'NOT_FOUND');
  const created = await svc.createVersion({ documentId: docId });
  const id = created.version.id;
  assert.equal((await svc.updateVersion(id, { approvalStatus: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.updateVersion(id, { metadata: 9 })).code, 'VALIDATION');
  const upd = await svc.updateVersion(id, { approvalStatus: 'APPROVED', approvedBy: 5, approvedDate: '2026-07-09', metadata: { r: 1 } });
  assert.equal(upd.version.approvalStatus, 'APPROVED');
  assert.equal(upd.version.approvedBy, 5);
  assert.deepEqual(upd.version.metadata, { r: 1 });
  assert.equal((await svc.updateVersion(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- lifecycle ----

test('W26V-SVC-15. archiveVersion success / NOT_FOUND / already-archived', async () => {
  const { db, svc, docId } = await freshService();
  const created = await svc.createVersion({ documentId: docId });
  const id = created.version.id;
  assert.equal((await svc.archiveVersion(id)).version.archived, 1);
  assert.equal((await svc.archiveVersion(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveVersion(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26V-SVC-16. deleteVersion success then NOT_FOUND on re-delete', async () => {
  const { db, svc, docId } = await freshService();
  const created = await svc.createVersion({ documentId: docId });
  const id = created.version.id;
  assert.equal((await svc.deleteVersion(id)).ok, true);
  assert.equal((await svc.deleteVersion(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26V-SVC-17. restoreVersion restores a soft-deleted version; NOT_FOUND for unknown id', async () => {
  const { db, svc, docId } = await freshService();
  const created = await svc.createVersion({ documentId: docId });
  const id = created.version.id;
  await svc.deleteVersion(id);
  const restored = await svc.restoreVersion(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.version.deleted, 0);
  assert.equal((await svc.restoreVersion(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26V-SVC-18. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getVersion(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26V-SVC-19. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findVersion', 'boom-string');
  const r = await svc.createVersion({ documentId: 1, majorVersion: 1 });
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});

test('W26V-SVC-20. listVersions returns an empty list for a document with no versions', async () => {
  const { db, svc, docId } = await freshService();
  const r = await svc.listVersions(docId);
  assert.equal(r.ok, true);
  assert.deepEqual(r.versions, []);
  db.close();
});

test('W26V-SVC-21. duplicate version is rejected even when it is not the latest', async () => {
  const { db, svc, docId } = await freshService();
  await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 });
  await svc.createVersion({ documentId: docId, majorVersion: 2, minorVersion: 0 });
  // 1.0 already exists (now superseded but not deleted) → uniqueness still applies
  assert.equal((await svc.createVersion({ documentId: docId, majorVersion: 1, minorVersion: 0 })).code, 'CONFLICT');
  db.close();
});
