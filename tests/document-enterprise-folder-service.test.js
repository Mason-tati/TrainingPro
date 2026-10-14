// WP-26 · Phase 2 — Enterprise Folder service tests (business rules; ephemeral in-memory DB).
// Covers hierarchy, path/depth generation, security inheritance, unique number/path, move + subtree
// cascade, circular-reference prevention, archive/soft-delete/restore/move/metadata/retention
// validation, and never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const Mig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const Repository = require(path.join(EDIR, 'enterprise-folder-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-folder-service.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findChildren', 'findByPath', 'findRootFolders', 'moveFolder', 'archive', 'restore', 'softDelete', 'exists', 'count'];

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
// convenience: create and return the folder record
async function mkFolder(svc, over) {
  const r = await svc.createFolder(over);
  assert.equal(r.ok, true, `create ${over.folderNumber} failed: ${r.error}`);
  return r.folder;
}

// ---- construction ----

test('W26F-SVC-1. constructor validates the injected repository', () => {
  assert.throws(() => new Service({}), /Injected repository must implement/);
});

// ---- create: validation ----

test('W26F-SVC-2. createFolder validates folderName/folderNumber (non-object input too)', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createFolder(null)).code, 'VALIDATION');
  assert.equal((await svc.createFolder({ folderNumber: 'X' })).code, 'VALIDATION');
  assert.equal((await svc.createFolder({ folderName: '  ' })).code, 'VALIDATION');
  assert.equal((await svc.createFolder({ folderName: 'F' })).code, 'VALIDATION', 'missing folderNumber');
  db.close();
});

test('W26F-SVC-3. createFolder validates metadata / retention / securityClassification', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createFolder({ folderNumber: 'V1', folderName: 'F', metadata: 'no' })).code, 'VALIDATION');
  assert.equal((await svc.createFolder({ folderNumber: 'V2', folderName: 'F', retentionCategory: 'FOREVER' })).code, 'VALIDATION');
  assert.equal((await svc.createFolder({ folderNumber: 'V3', folderName: 'F', securityClassification: 'COSMIC' })).code, 'VALIDATION');
  db.close();
});

test('W26F-SVC-4. createFolder enforces unique folderNumber and unique folderPath', async () => {
  const { db, svc } = await freshService();
  await mkFolder(svc, { folderNumber: 'U1', folderName: 'Alpha' });
  assert.equal((await svc.createFolder({ folderNumber: 'U1', folderName: 'Beta' })).code, 'CONFLICT', 'dup number');
  assert.equal((await svc.createFolder({ folderNumber: 'U2', folderName: 'Alpha' })).code, 'CONFLICT', 'dup path');
  db.close();
});

test('W26F-SVC-5. createFolder root: path=/name, depth 0, default security INTERNAL', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'R1', folderName: 'Root' });
  assert.equal(f.folderPath, '/Root');
  assert.equal(f.folderDepth, 0);
  assert.equal(f.securityClassification, 'INTERNAL');
  assert.equal(f.retentionCategory, 'STANDARD');
  assert.equal(f.active, 1);
  db.close();
});

test('W26F-SVC-6. createFolder with explicit parentFolderId:null is treated as a root', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'RN', folderName: 'RootNull', parentFolderId: null });
  assert.equal(f.folderDepth, 0);
  assert.equal(f.folderPath, '/RootNull');
  db.close();
});

test('W26F-SVC-7. createFolder rejects a non-existent parent', async () => {
  const { db, svc } = await freshService();
  const r = await svc.createFolder({ folderNumber: 'CP', folderName: 'Child', parentFolderId: 9999 });
  assert.equal(r.code, 'VALIDATION');
  db.close();
});

test('W26F-SVC-8. createFolder child: path/depth derived from parent; security inherited', async () => {
  const { db, svc } = await freshService();
  const root = await mkFolder(svc, { folderNumber: 'P1', folderName: 'Policies', securityClassification: 'CONFIDENTIAL' });
  const child = await mkFolder(svc, { folderNumber: 'P2', folderName: 'HR', parentFolderId: root.id });
  assert.equal(child.folderPath, '/Policies/HR');
  assert.equal(child.folderDepth, 1);
  assert.equal(child.securityClassification, 'CONFIDENTIAL', 'inherited from parent');
  db.close();
});

test('W26F-SVC-9. child may override inherited security with a valid classification', async () => {
  const { db, svc } = await freshService();
  const root = await mkFolder(svc, { folderNumber: 'O1', folderName: 'Ops', securityClassification: 'CONFIDENTIAL' });
  const child = await mkFolder(svc, { folderNumber: 'O2', folderName: 'Public', parentFolderId: root.id, securityClassification: 'PUBLIC' });
  assert.equal(child.securityClassification, 'PUBLIC');
  db.close();
});

test('W26F-SVC-10. createFolder (full) persists provided fields and parses metadata; metadataJson string accepted', async () => {
  const { db, svc } = await freshService();
  const full = await mkFolder(svc, {
    folderNumber: 'FL', folderName: 'Full', description: 'd', category: 'HR', subCategory: 'Policy',
    department: 'Corp', site: 'HQ', businessUnit: 'BU1', ownerId: 3, sortOrder: 5, retentionCategory: 'LONG',
    securityClassification: 'RESTRICTED', metadata: { k: 'v' },
  });
  assert.equal(full.retentionCategory, 'LONG');
  assert.equal(full.sortOrder, 5);
  assert.deepEqual(full.metadata, { k: 'v' });
  const raw = await mkFolder(svc, { folderNumber: 'RJ', folderName: 'Raw', metadataJson: '{"x":1}' });
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- read ----

test('W26F-SVC-11. getFolder found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'G1', folderName: 'G' });
  assert.equal((await svc.getFolder(f.id)).ok, true);
  assert.equal((await svc.getFolder(9999)).code, 'NOT_FOUND');
  const repo = new Repository(db);
  const bad = await repo.create({ folderNumber: 'BAD', folderName: 'Bad', folderPath: '/Bad', folderDepth: 0, metadataJson: '{oops' });
  assert.equal((await svc.getFolder(bad.id)).folder.metadata, null);
  db.close();
});

test('W26F-SVC-12. listRootFolders and listChildren', async () => {
  const { db, svc } = await freshService();
  const root = await mkFolder(svc, { folderNumber: 'LR1', folderName: 'A' });
  await mkFolder(svc, { folderNumber: 'LR2', folderName: 'B' });
  await mkFolder(svc, { folderNumber: 'LC1', folderName: 'A1', parentFolderId: root.id });
  assert.equal((await svc.listRootFolders()).folders.length, 2);
  assert.equal((await svc.listChildren(root.id)).folders.length, 1);
  db.close();
});

// ---- update ----

test('W26F-SVC-13. updateFolder NOT_FOUND / validation / success', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.updateFolder(4242, { description: 'x' })).code, 'NOT_FOUND');
  const f = await mkFolder(svc, { folderNumber: 'UP', folderName: 'Up' });
  assert.equal((await svc.updateFolder(f.id, { securityClassification: 'COSMIC' })).code, 'VALIDATION');
  assert.equal((await svc.updateFolder(f.id, { retentionCategory: 'ETERNAL' })).code, 'VALIDATION');
  assert.equal((await svc.updateFolder(f.id, { metadata: 9 })).code, 'VALIDATION');
  const upd = await svc.updateFolder(f.id, { description: 'new', category: 'HR', metadata: { a: 1 } });
  assert.equal(upd.folder.description, 'new');
  assert.deepEqual(upd.folder.metadata, { a: 1 });
  const noop = await svc.updateFolder(f.id, null);
  assert.equal(noop.ok, true);
  db.close();
});

// ---- move ----

test('W26F-SVC-14. moveFolder NOT_FOUND for a missing folder', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.moveFolder(999, null)).code, 'NOT_FOUND');
  db.close();
});

test('W26F-SVC-15. moveFolder to root (null) is a no-op path (self-path allowed)', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'MR', folderName: 'Solo' });
  const r = await svc.moveFolder(f.id, null); // newPath == current path → clash is itself → allowed
  assert.equal(r.ok, true);
  assert.equal(r.folder.folderPath, '/Solo');
  assert.equal(r.folder.folderDepth, 0);
  db.close();
});

test('W26F-SVC-16. moveFolder rejects self-move and a non-existent target parent', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'SM', folderName: 'Self' });
  assert.equal((await svc.moveFolder(f.id, f.id)).code, 'VALIDATION', 'self-move');
  assert.equal((await svc.moveFolder(f.id, 8888)).code, 'VALIDATION', 'missing target');
  db.close();
});

test('W26F-SVC-17. moveFolder relocates a subtree and cascades path/depth to descendants', async () => {
  const { db, svc } = await freshService();
  const root = await mkFolder(svc, { folderNumber: 'T1', folderName: 'Policies' });
  const hr = await mkFolder(svc, { folderNumber: 'T2', folderName: 'HR', parentFolderId: root.id });
  const leave = await mkFolder(svc, { folderNumber: 'T3', folderName: 'Leave', parentFolderId: hr.id });
  const archive = await mkFolder(svc, { folderNumber: 'T4', folderName: 'Archive' });
  const moved = await svc.moveFolder(hr.id, archive.id);
  assert.equal(moved.folder.folderPath, '/Archive/HR');
  assert.equal(moved.folder.folderDepth, 1);
  const leaveAfter = await svc.getFolder(leave.id);
  assert.equal(leaveAfter.folder.folderPath, '/Archive/HR/Leave', 'descendant cascaded');
  assert.equal(leaveAfter.folder.folderDepth, 2);
  db.close();
});

test('W26F-SVC-18. moveFolder prevents circular references (moving an ancestor under its descendant)', async () => {
  const { db, svc } = await freshService();
  const a = await mkFolder(svc, { folderNumber: 'CA', folderName: 'A' });
  const b = await mkFolder(svc, { folderNumber: 'CB', folderName: 'B', parentFolderId: a.id });
  const c = await mkFolder(svc, { folderNumber: 'CC', folderName: 'C', parentFolderId: b.id });
  assert.equal((await svc.moveFolder(a.id, c.id)).code, 'VALIDATION', 'A cannot move under its descendant C');
  db.close();
});

test('W26F-SVC-19. moveFolder allows a valid deep relocation between separate subtrees', async () => {
  const { db, svc } = await freshService();
  const r = await mkFolder(svc, { folderNumber: 'D0', folderName: 'R' });
  const a = await mkFolder(svc, { folderNumber: 'D1', folderName: 'A', parentFolderId: r.id });
  const b = await mkFolder(svc, { folderNumber: 'D2', folderName: 'B', parentFolderId: a.id });
  const x = await mkFolder(svc, { folderNumber: 'D3', folderName: 'X', parentFolderId: r.id });
  const moved = await svc.moveFolder(x.id, b.id); // X under B (deep, non-circular): walks B→A→R
  assert.equal(moved.ok, true);
  assert.equal(moved.folder.folderPath, '/R/A/B/X');
  assert.equal(moved.folder.folderDepth, 3);
  db.close();
});

test('W26F-SVC-20. moveFolder rejects a destination whose path is occupied by another folder', async () => {
  const { db, svc } = await freshService();
  const root = await mkFolder(svc, { folderNumber: 'PC0', folderName: 'Root' });
  await mkFolder(svc, { folderNumber: 'PC1', folderName: 'Dup', parentFolderId: root.id }); // occupies /Root/Dup
  const other = await mkFolder(svc, { folderNumber: 'PC2', folderName: 'Dup' }); // root-level /Dup
  const r = await svc.moveFolder(other.id, root.id); // would become /Root/Dup → clash with PC1
  assert.equal(r.code, 'CONFLICT');
  db.close();
});

// ---- archive / delete / restore ----

test('W26F-SVC-21. archiveFolder success / NOT_FOUND / already-archived', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'A1', folderName: 'Arch' });
  assert.equal((await svc.archiveFolder(f.id)).folder.archived, 1);
  assert.equal((await svc.archiveFolder(f.id)).code, 'VALIDATION');
  assert.equal((await svc.archiveFolder(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26F-SVC-22. deleteFolder: NOT_FOUND, non-empty rejected, empty leaf deleted', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.deleteFolder(999)).code, 'NOT_FOUND');
  const parent = await mkFolder(svc, { folderNumber: 'DP', folderName: 'Parent' });
  const child = await mkFolder(svc, { folderNumber: 'DC', folderName: 'Child', parentFolderId: parent.id });
  assert.equal((await svc.deleteFolder(parent.id)).code, 'VALIDATION', 'not empty');
  assert.equal((await svc.deleteFolder(child.id)).ok, true, 'leaf deletes');
  db.close();
});

test('W26F-SVC-23. restoreFolder restores a soft-deleted folder; NOT_FOUND for unknown id', async () => {
  const { db, svc } = await freshService();
  const f = await mkFolder(svc, { folderNumber: 'RS', folderName: 'Rest' });
  await svc.deleteFolder(f.id);
  const restored = await svc.restoreFolder(f.id);
  assert.equal(restored.ok, true);
  assert.equal(restored.folder.deleted, 0);
  assert.equal(restored.folder.active, 1);
  assert.equal((await svc.restoreFolder(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26F-SVC-24. an unexpected repository error degrades to { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getFolder(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26F-SVC-25. an error without a message degrades to a generic ERROR string', async () => {
  const svc = throwingService('count', 'boom-string');
  const r = await svc.createFolder({ folderNumber: 'E', folderName: 'E' });
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
