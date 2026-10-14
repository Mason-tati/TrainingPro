// WP-26 · Phase 3 — Enterprise Document Core service tests (business rules; ephemeral in-memory DB).
// Covers folder existence validation + security/retention inheritance (via injected Phase-2 folder
// repository), unique document numbers, revision/status validation, metadata/search validation,
// archive/restore/delete, and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const FSvc = require(path.join(EDIR, 'enterprise-folder-service.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByNumber', 'findByFolder', 'findByStatus', 'search', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await DMig.migrate(db);
  await FMig.migrate(db);
  const folderRepo = new FRepo(db);
  const folderSvc = new FSvc(folderRepo);
  const svc = new Service(new DRepo(db), folderRepo);
  return { db, svc, folderSvc };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return null; } });
}
async function mkFolder(folderSvc, over) {
  const r = await folderSvc.createFolder(over);
  assert.equal(r.ok, true, `folder create failed: ${r.error}`);
  return r.folder;
}

// ---- construction ----

test('W26C-SVC-1. constructor validates the document repository AND requires a folder repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected folder repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected folder repository/);
});

// ---- create: validation ----

test('W26C-SVC-2. createDocument validates title/number (non-object input too)', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument(null)).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'X' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentTitle: '  ' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentTitle: 'T' })).code, 'VALIDATION', 'missing number');
  db.close();
});

test('W26C-SVC-3. createDocument validates revision / status / metadata', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument({ documentNumber: 'R1', documentTitle: 'T', revision: 0 })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'R2', documentTitle: 'T', revision: 1.5 })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'R3', documentTitle: 'T', revision: 'A' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'ST', documentTitle: 'T', status: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'MD', documentTitle: 'T', metadata: 'no' })).code, 'VALIDATION');
  db.close();
});

test('W26C-SVC-4. createDocument enforces unique document numbers', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument({ documentNumber: 'U1', documentTitle: 'A' })).ok, true);
  assert.equal((await svc.createDocument({ documentNumber: 'U1', documentTitle: 'B' })).code, 'CONFLICT');
  db.close();
});

test('W26C-SVC-5. createDocument rejects a non-existent folder', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument({ documentNumber: 'BF', documentTitle: 'T', folderId: 9999 })).code, 'VALIDATION');
  db.close();
});

test('W26C-SVC-6. createDocument rejects invalid explicit security / retention', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument({ documentNumber: 'SC', documentTitle: 'T', securityClassification: 'COSMIC' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'RC', documentTitle: 'T', retentionCategory: 'ETERNAL' })).code, 'VALIDATION');
  db.close();
});

// ---- create: inheritance + defaults ----

test('W26C-SVC-7. unfiled document defaults security=INTERNAL, retention=STANDARD, revision=1, status=DRAFT', async () => {
  const { db, svc } = await freshService();
  const d = (await svc.createDocument({ documentNumber: 'MIN', documentTitle: 'Minimal' })).document;
  assert.equal(d.securityClassification, 'INTERNAL');
  assert.equal(d.retentionCategory, 'STANDARD');
  assert.equal(d.revision, 1);
  assert.equal(d.status, 'DRAFT');
  assert.equal(d.language, 'en');
  assert.equal(d.folderId, null);
  assert.equal(d.metadata, null);
  db.close();
});

test('W26C-SVC-8. document inherits security + retention from its folder', async () => {
  const { db, svc, folderSvc } = await freshService();
  const folder = await mkFolder(folderSvc, { folderNumber: 'FL', folderName: 'Secure', securityClassification: 'CONFIDENTIAL', retentionCategory: 'LONG' });
  const d = (await svc.createDocument({ documentNumber: 'IN', documentTitle: 'T', folderId: folder.id })).document;
  assert.equal(d.folderId, folder.id);
  assert.equal(d.securityClassification, 'CONFIDENTIAL');
  assert.equal(d.retentionCategory, 'LONG');
  db.close();
});

test('W26C-SVC-9. explicit security/retention override folder inheritance', async () => {
  const { db, svc, folderSvc } = await freshService();
  const folder = await mkFolder(folderSvc, { folderNumber: 'FL2', folderName: 'Sec2', securityClassification: 'CONFIDENTIAL', retentionCategory: 'LONG' });
  const d = (await svc.createDocument({ documentNumber: 'OV', documentTitle: 'T', folderId: folder.id, securityClassification: 'PUBLIC', retentionCategory: 'SHORT' })).document;
  assert.equal(d.securityClassification, 'PUBLIC');
  assert.equal(d.retentionCategory, 'SHORT');
  db.close();
});

test('W26C-SVC-10. explicit folderId:null is treated as unfiled', async () => {
  const { db, svc } = await freshService();
  const d = (await svc.createDocument({ documentNumber: 'NL', documentTitle: 'T', folderId: null })).document;
  assert.equal(d.folderId, null);
  assert.equal(d.securityClassification, 'INTERNAL');
  db.close();
});

test('W26C-SVC-11. createDocument (full) persists every provided field and parses metadata; metadataJson string accepted', async () => {
  const { db, svc } = await freshService();
  const d = (await svc.createDocument({
    documentNumber: 'FULL', documentTitle: 'Full', documentType: 'SOP', revision: 4, status: 'APPROVED',
    description: 'd', keywords: 'k1 k2', ownerId: 7, department: 'HR', site: 'HQ', businessUnit: 'BU',
    securityClassification: 'RESTRICTED', retentionCategory: 'PERMANENT', effectiveDate: '2026-01-01',
    reviewDate: '2026-06-01', expiryDate: '2027-01-01', language: 'fr', fileName: 'f.pdf', fileExtension: 'pdf',
    mimeType: 'application/pdf', fileSize: 2048, checksum: 'sha', storagePath: '/s/f.pdf', metadata: { a: 1 },
  })).document;
  assert.equal(d.revision, 4);
  assert.equal(d.fileSize, 2048);
  assert.deepEqual(d.metadata, { a: 1 });
  const raw = (await svc.createDocument({ documentNumber: 'RJ', documentTitle: 'Raw', metadataJson: '{"x":1}' })).document;
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- read ----

test('W26C-SVC-12. getDocument found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'G1', documentTitle: 'T' });
  assert.equal((await svc.getDocument(created.document.id)).ok, true);
  assert.equal((await svc.getDocument(9999)).code, 'NOT_FOUND');
  const repo = new DRepo(db);
  const bad = await repo.create({ documentNumber: 'BAD', documentTitle: 'B', metadataJson: '{oops' });
  assert.equal((await svc.getDocument(bad.id)).document.metadata, null);
  db.close();
});

test('W26C-SVC-13. listFolderDocuments returns documents in a folder', async () => {
  const { db, svc, folderSvc } = await freshService();
  const folder = await mkFolder(folderSvc, { folderNumber: 'LF', folderName: 'F' });
  await svc.createDocument({ documentNumber: 'D1', documentTitle: 'A', folderId: folder.id });
  await svc.createDocument({ documentNumber: 'D2', documentTitle: 'B', folderId: folder.id });
  assert.equal((await svc.listFolderDocuments(folder.id)).documents.length, 2);
  db.close();
});

// ---- search ----

test('W26C-SVC-14. searchDocuments: filters, free-text, non-object criteria, and invalid status', async () => {
  const { db, svc } = await freshService();
  await svc.createDocument({ documentNumber: 'SR1', documentTitle: 'Safety Plan', status: 'DRAFT', keywords: 'osha' });
  await svc.createDocument({ documentNumber: 'SR2', documentTitle: 'Menu', status: 'APPROVED', keywords: 'lunch plan' });
  assert.equal((await svc.searchDocuments({ status: 'DRAFT' })).documents.length, 1);
  assert.equal((await svc.searchDocuments({ text: 'plan' })).documents.length, 2);
  assert.equal((await svc.searchDocuments('nope')).documents.length, 2, 'non-object → all');
  assert.equal((await svc.searchDocuments({ status: 'BOGUS' })).code, 'VALIDATION');
  db.close();
});

// ---- update ----

test('W26C-SVC-15. updateDocument NOT_FOUND / validation / success', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.updateDocument(4242, { documentTitle: 'x' })).code, 'NOT_FOUND');
  const created = await svc.createDocument({ documentNumber: 'UP', documentTitle: 'Old' });
  const id = created.document.id;
  assert.equal((await svc.updateDocument(id, { revision: 0 })).code, 'VALIDATION');
  assert.equal((await svc.updateDocument(id, { status: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.updateDocument(id, { securityClassification: 'COSMIC' })).code, 'VALIDATION');
  assert.equal((await svc.updateDocument(id, { retentionCategory: 'ETERNAL' })).code, 'VALIDATION');
  assert.equal((await svc.updateDocument(id, { metadata: 9 })).code, 'VALIDATION');
  const upd = await svc.updateDocument(id, { documentTitle: 'New', status: 'APPROVED', revision: 2, metadata: { r: 1 } });
  assert.equal(upd.document.documentTitle, 'New');
  assert.equal(upd.document.revision, 2);
  assert.deepEqual(upd.document.metadata, { r: 1 });
  assert.equal((await svc.updateDocument(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- lifecycle ----

test('W26C-SVC-16. archiveDocument success / NOT_FOUND / already-archived', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'AR', documentTitle: 'T' });
  const id = created.document.id;
  assert.equal((await svc.archiveDocument(id)).document.archived, 1);
  assert.equal((await svc.archiveDocument(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveDocument(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26C-SVC-17. deleteDocument success then NOT_FOUND on re-delete', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'DL', documentTitle: 'T' });
  const id = created.document.id;
  assert.equal((await svc.deleteDocument(id)).ok, true);
  assert.equal((await svc.deleteDocument(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26C-SVC-18. restoreDocument restores a soft-deleted document; NOT_FOUND for unknown id', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'RS', documentTitle: 'T' });
  const id = created.document.id;
  await svc.deleteDocument(id);
  const restored = await svc.restoreDocument(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.document.deleted, 0);
  assert.equal(restored.document.active, 1);
  assert.equal((await svc.restoreDocument(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26C-SVC-19. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getDocument(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26C-SVC-20. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findByNumber', 'boom-string');
  const r = await svc.createDocument({ documentNumber: 'E', documentTitle: 'E' });
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
