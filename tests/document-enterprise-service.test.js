// WP-26 · Phase 1 — Enterprise Document service tests (business rules; ephemeral in-memory DB).
// The service enforces unique numbers, version/current-version defaults, archive/soft-delete/
// metadata/security-classification/lifecycle validation over an injected repository (reusing
// BaseService). Never-throw: every method resolves an explicit { ok, ... } result.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-document-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-document-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-service.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByNumber', 'findAll', 'archive', 'softDelete', 'restore', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, svc: new Service(new Repository(db)) };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo);
}

// ---- construction ----

test('W26-SVC-1. constructor validates the injected repository (BaseService contract)', () => {
  assert.throws(() => new Service({}), /Injected repository must implement/);
});

// ---- create: validation ----

test('W26-SVC-2. createDocument rejects missing/blank title (non-object input too)', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument(null)).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'X' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'X', title: '   ' })).code, 'VALIDATION');
  db.close();
});

test('W26-SVC-3. createDocument rejects missing documentNumber', async () => {
  const { db, svc } = await freshService();
  const r = await svc.createDocument({ title: 'T' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'VALIDATION');
  db.close();
});

test('W26-SVC-4. createDocument rejects invalid status and invalid securityClassification', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument({ documentNumber: 'S1', title: 'T', status: 'WEIRD' })).code, 'VALIDATION');
  assert.equal((await svc.createDocument({ documentNumber: 'S2', title: 'T', securityClassification: 'COSMIC' })).code, 'VALIDATION');
  db.close();
});

test('W26-SVC-5. createDocument rejects non-object metadata', async () => {
  const { db, svc } = await freshService();
  const r = await svc.createDocument({ documentNumber: 'M1', title: 'T', metadata: 'nope' });
  assert.equal(r.code, 'VALIDATION');
  db.close();
});

test('W26-SVC-6. createDocument enforces unique document numbers', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDocument({ documentNumber: 'U1', title: 'A' })).ok, true);
  const dup = await svc.createDocument({ documentNumber: 'U1', title: 'B' });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'CONFLICT');
  db.close();
});

// ---- create: happy paths + defaults ----

test('W26-SVC-7. createDocument (minimal) applies version/current-version/status/classification defaults', async () => {
  const { db, svc } = await freshService();
  const r = await svc.createDocument({ documentNumber: 'MIN', title: 'Minimal' });
  assert.equal(r.ok, true);
  assert.equal(r.document.versionMajor, 1);
  assert.equal(r.document.versionMinor, 0);
  assert.equal(r.document.currentVersion, 1);
  assert.equal(r.document.status, 'DRAFT');
  assert.equal(r.document.securityClassification, 'INTERNAL');
  assert.equal(r.document.language, 'en');
  assert.equal(r.document.metadata, null);
  db.close();
});

test('W26-SVC-8. createDocument (full) persists every provided field and parses metadata', async () => {
  const { db, svc } = await freshService();
  const r = await svc.createDocument({
    documentNumber: 'FULL', title: 'Full', description: 'd', category: 'HR', subCategory: 'Policy',
    documentType: 'SOP', versionMajor: 2, versionMinor: 3, status: 'APPROVED', ownerId: 5, approverId: 9,
    securityClassification: 'CONFIDENTIAL', language: 'fr', approvedAt: '2026-01-01', effectiveDate: '2026-02-01',
    reviewDate: '2026-06-01', expiryDate: '2027-01-01', supersededBy: null, metadata: { k: 'v' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.document.versionMajor, 2);
  assert.equal(r.document.securityClassification, 'CONFIDENTIAL');
  assert.equal(r.document.language, 'fr');
  assert.deepEqual(r.document.metadata, { k: 'v' });
  db.close();
});

test('W26-SVC-9. createDocument accepts a raw metadataJson string when metadata is absent', async () => {
  const { db, svc } = await freshService();
  const r = await svc.createDocument({ documentNumber: 'RAWJSON', title: 'T', metadataJson: '{"x":1}' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.document.metadata, { x: 1 });
  db.close();
});

// ---- read ----

test('W26-SVC-10. getDocument returns found / NOT_FOUND', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'G1', title: 'T' });
  assert.equal((await svc.getDocument(created.document.id)).ok, true);
  const missing = await svc.getDocument(9999);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'NOT_FOUND');
  db.close();
});

test('W26-SVC-11. getDocument tolerates corrupt metadataJson (metadata → null, never throws)', async () => {
  const { db, svc } = await freshService();
  const repo = new Repository(db);
  const created = await repo.create({ documentNumber: 'BAD', title: 'T', metadataJson: '{not json' });
  const r = await svc.getDocument(created.id);
  assert.equal(r.ok, true);
  assert.equal(r.document.metadata, null);
  db.close();
});

test('W26-SVC-12. listDocuments and countDocuments honour filters', async () => {
  const { db, svc } = await freshService();
  await svc.createDocument({ documentNumber: 'L1', title: 'a', category: 'HR' });
  await svc.createDocument({ documentNumber: 'L2', title: 'b', category: 'OPS' });
  const list = await svc.listDocuments({ category: 'HR' });
  assert.equal(list.ok, true);
  assert.equal(list.documents.length, 1);
  assert.equal((await svc.countDocuments({})).count, 2);
  db.close();
});

// ---- update ----

test('W26-SVC-13. updateDocument NOT_FOUND for a missing id', async () => {
  const { db, svc } = await freshService();
  const r = await svc.updateDocument(4242, { title: 'x' });
  assert.equal(r.code, 'NOT_FOUND');
  db.close();
});

test('W26-SVC-14. updateDocument validates status/classification/metadata when present', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'UP1', title: 'T' });
  const id = created.document.id;
  assert.equal((await svc.updateDocument(id, { status: 'WEIRD' })).code, 'VALIDATION');
  assert.equal((await svc.updateDocument(id, { securityClassification: 'COSMIC' })).code, 'VALIDATION');
  assert.equal((await svc.updateDocument(id, { metadata: 7 })).code, 'VALIDATION');
  db.close();
});

test('W26-SVC-15. updateDocument applies field + metadata changes; empty/non-object patch is a no-op success', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'UP2', title: 'Old' });
  const id = created.document.id;
  const upd = await svc.updateDocument(id, { title: 'New', status: 'APPROVED', metadata: { r: 1 } });
  assert.equal(upd.ok, true);
  assert.equal(upd.document.title, 'New');
  assert.equal(upd.document.status, 'APPROVED');
  assert.deepEqual(upd.document.metadata, { r: 1 });
  const noop = await svc.updateDocument(id, null); // non-object patch → {} → only updatedAt
  assert.equal(noop.ok, true);
  assert.equal(noop.document.title, 'New');
  db.close();
});

// ---- lifecycle: archive / delete / restore ----

test('W26-SVC-16. archiveDocument: success, NOT_FOUND, and already-archived validation', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'AR1', title: 'T' });
  const id = created.document.id;
  const first = await svc.archiveDocument(id);
  assert.equal(first.ok, true);
  assert.equal(first.document.archived, 1);
  assert.equal((await svc.archiveDocument(id)).code, 'VALIDATION', 'already archived');
  assert.equal((await svc.archiveDocument(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26-SVC-17. deleteDocument: success then NOT_FOUND on re-delete (soft-delete validation)', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'DL1', title: 'T' });
  const id = created.document.id;
  assert.equal((await svc.deleteDocument(id)).ok, true);
  assert.equal((await svc.deleteDocument(id)).code, 'NOT_FOUND', 'already deleted');
  db.close();
});

test('W26-SVC-18. restoreDocument: restores a soft-deleted document; NOT_FOUND for unknown id', async () => {
  const { db, svc } = await freshService();
  const created = await svc.createDocument({ documentNumber: 'RS1', title: 'T' });
  const id = created.document.id;
  await svc.deleteDocument(id);
  const restored = await svc.restoreDocument(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.document.deleted, 0);
  assert.equal((await svc.restoreDocument(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw executor ----

test('W26-SVC-19. an unexpected repository error degrades to { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getDocument(1);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26-SVC-20. an error without a message degrades to a generic ERROR string', async () => {
  const svc = throwingService('count', 'plain-string-throw');
  const r = await svc.countDocuments({});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
