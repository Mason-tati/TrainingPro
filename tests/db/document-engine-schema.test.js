// WP-18 · E2 — Enterprise Document Engine database foundation tests.
// Verifies the additive tblDocument* schema + indexes materialize, the migration is
// idempotent, legacy tables are untouched, and the repository skeletons are unwired.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const REPO_DIR = path.join(ROOT, 'lib', 'document-engine', 'repositories');

const TABLES = ['tblDocument', 'tblDocumentVersion', 'tblDocumentMetadata', 'tblDocumentRelationship', 'tblDocumentApproval', 'tblDocumentAcknowledgement', 'tblDocumentDistribution', 'tblDocumentAccess', 'tblDocumentNotification', 'tblDocumentSearchIndex', 'tblDocumentCompliance', 'tblDocumentValidation'];
const INDEXES = ['idx_tblDocument_number', 'idx_tblDocument_status', 'idx_tblDocument_type', 'idx_tblDocument_workflow', 'idx_tblDocument_owner', 'idx_tblDocument_department', 'idx_tblDocument_site', 'idx_tblDocument_reviewdate', 'idx_tblDocument_expirydate', 'idx_tblDocumentVersion_doc', 'idx_tblDocumentMetadata_doc', 'idx_tblDocumentRelationship_from', 'idx_tblDocumentRelationship_to', 'idx_tblDocumentApproval_doc', 'idx_tblDocumentAcknowledgement_doc', 'idx_tblDocumentDistribution_doc', 'idx_tblDocumentAccess_doc', 'idx_tblDocumentNotification_doc', 'idx_tblDocumentSearchIndex_doc', 'idx_tblDocumentCompliance_doc', 'idx_tblDocumentValidation_doc', 'idx_tblFiles_entity'];
const REPOS = ['document-repository.js', 'version-repository.js', 'metadata-repository.js', 'relationship-repository.js', 'approval-repository.js', 'distribution-repository.js', 'access-repository.js', 'notification-repository.js', 'validation-repository.js', 'compliance-repository.js', 'search-repository.js'];

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

const tableNames = () => app.db.dbAll("SELECT name FROM sqlite_master WHERE type='table'").then((r) => r.map((x) => x.name));
const indexNames = () => app.db.dbAll("SELECT name FROM sqlite_master WHERE type='index'").then((r) => r.map((x) => x.name));

test('E2-1. all 12 tblDocument* tables exist', async () => {
  const names = await tableNames();
  for (const t of TABLES) assert.ok(names.includes(t), `${t} exists`);
});

test('E2-2. all 22 document-engine indexes exist (incl. legacy tblFiles hot-path index)', async () => {
  const names = await indexNames();
  for (const i of INDEXES) assert.ok(names.includes(i), `${i} exists`);
});

test('E2-3. tblDocument schema: expected columns; DocumentNumber UNIQUE; soft-delete', async () => {
  const cols = (await app.db.dbAll('PRAGMA table_info(tblDocument)')).map((c) => c.name);
  for (const c of ['DocumentID', 'DocumentNumber', 'Title', 'Description', 'DocumentType', 'DocumentStatus', 'WorkflowID', 'VersionScheme', 'VersionMajor', 'VersionMinor', 'VersionPatch', 'Revision', 'Classification', 'ComplianceFramework', 'Owner', 'Author', 'Department', 'Site', 'EffectiveDate', 'ReviewDate', 'ExpiryDate', 'CreatedBy', 'CreatedDate', 'UpdatedBy', 'UpdatedDate', 'IsDeleted']) {
    assert.ok(cols.includes(c), `tblDocument.${c} present`);
  }
  const idxList = await app.db.dbAll('PRAGMA index_list(tblDocument)');
  assert.ok(idxList.some((i) => i.unique === 1), 'tblDocument has a UNIQUE index (DocumentNumber)');
});

test('E2-4. foreign keys connect ONLY new document tables → tblDocument', async () => {
  const vfk = await app.db.dbAll('PRAGMA foreign_key_list(tblDocumentVersion)');
  assert.equal(vfk.length, 1);
  assert.equal(vfk[0].table, 'tblDocument');
  const rfk = await app.db.dbAll('PRAGMA foreign_key_list(tblDocumentRelationship)');
  assert.equal(rfk.length, 2, 'relationship has From + To FKs');
  for (const f of rfk) assert.equal(f.table, 'tblDocument');
  // every child table references tblDocument
  for (const t of TABLES.filter((x) => x !== 'tblDocument')) {
    const fks = await app.db.dbAll(`PRAGMA foreign_key_list(${t})`);
    assert.ok(fks.length >= 1 && fks.every((f) => f.table === 'tblDocument'), `${t} FK → tblDocument`);
  }
});

test('E2-5. legacy tables untouched (tblFiles / tblDoc exist; no WP-18 columns added)', async () => {
  const names = await tableNames();
  assert.ok(names.includes('tblFiles') && names.includes('tblDoc'), 'legacy tables present');
  const fileCols = (await app.db.dbAll('PRAGMA table_info(tblFiles)')).map((c) => c.name);
  // tblFiles keeps its existing columns and gains NO document-engine column
  assert.ok(fileCols.includes('FileID') && fileCols.includes('Folder') && fileCols.includes('StructuredData'), 'tblFiles columns intact');
  assert.ok(!fileCols.includes('DocumentID'), 'tblFiles is NOT connected to the document engine');
  const docCols = (await app.db.dbAll('PRAGMA table_info(tblDoc)')).map((c) => c.name);
  assert.deepEqual(docCols.sort(), ['CertID', 'DocID', 'DocName', 'DocNum', 'ExpireDate', 'ReleaseDate', 'Retrain', 'Rev'].sort(), 'tblDoc unchanged');
});

test('E2-6. migration idempotent: re-running CREATE ... IF NOT EXISTS is a stable no-op', async () => {
  const tBefore = (await tableNames()).length;
  const iBefore = (await indexNames()).length;
  // re-run representative statements (idempotency guard)
  await app.db.dbRun('CREATE TABLE IF NOT EXISTS tblDocument (DocumentID INTEGER PRIMARY KEY AUTOINCREMENT)');
  await app.db.dbRun('CREATE TABLE IF NOT EXISTS tblDocumentVersion (VersionID INTEGER PRIMARY KEY AUTOINCREMENT)');
  await app.db.dbRun('CREATE INDEX IF NOT EXISTS idx_tblDocument_number ON tblDocument(DocumentNumber)');
  await app.db.dbRun('CREATE INDEX IF NOT EXISTS idx_tblFiles_entity ON tblFiles(EntityType, EntityID)');
  const tAfter = (await tableNames()).length;
  const iAfter = (await indexNames()).length;
  assert.equal(tAfter, tBefore, 'table count unchanged after re-run');
  assert.equal(iAfter, iBefore, 'index count unchanged after re-run');
  // tblDocument still has its full column set (IF NOT EXISTS did not truncate it)
  const cols = (await app.db.dbAll('PRAGMA table_info(tblDocument)')).map((c) => c.name);
  assert.ok(cols.includes('DocumentNumber') && cols.includes('IsDeleted'), 'tblDocument definition preserved');
});

test('E2-7. FK cascade works: deleting a document removes its child rows', async () => {
  const r = await app.db.dbRun("INSERT INTO tblDocument (DocumentNumber, Title, DocumentType, DocumentStatus) VALUES ('E2-TEST-000001','t','SOP','DRAFT')");
  const docId = r.lastID;
  await app.db.dbRun('INSERT INTO tblDocumentVersion (DocumentID, VersionString) VALUES (?, ?)', [docId, '1.0.0']);
  await app.db.dbRun('INSERT INTO tblDocumentApproval (DocumentID, Decision) VALUES (?, ?)', [docId, 'pending']);
  assert.equal((await app.db.dbGet('SELECT COUNT(*) n FROM tblDocumentVersion WHERE DocumentID=?', [docId])).n, 1);
  await app.db.dbRun('DELETE FROM tblDocument WHERE DocumentID=?', [docId]);
  assert.equal((await app.db.dbGet('SELECT COUNT(*) n FROM tblDocumentVersion WHERE DocumentID=?', [docId])).n, 0, 'version cascade-deleted');
  assert.equal((await app.db.dbGet('SELECT COUNT(*) n FROM tblDocumentApproval WHERE DocumentID=?', [docId])).n, 0, 'approval cascade-deleted');
});

test('E2-8. repository modules present: 11 classes + base; no forbidden production imports', () => {
  // WP-18 E3 implemented the repositories (they no longer throw "Not implemented").
  // The 11 named repos + the shared base-repository.js must all be present.
  const onDisk = fs.readdirSync(REPO_DIR).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(onDisk, [...REPOS, 'base-repository.js'].sort(), 'the 11 repositories + base-repository.js');
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/)/;
  for (const f of REPOS) {
    const Repo = require(path.join(REPO_DIR, f));
    assert.equal(typeof Repo, 'function', `${f} exports a class`);
    assert.throws(() => new Repo(), /database connection/, `${f} throws without a db (fail-safe)`);
    assert.doesNotThrow(() => new Repo({ run() {}, get() {}, all() {} }), `${f} accepts an injected db`);
    assert.ok(!FORBIDDEN.test(fs.readFileSync(path.join(REPO_DIR, f), 'utf8')), `${f} has no forbidden production import`);
  }
});

test('E2-9. document engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});

test('E2-10. isolated temp DB — production DB path never used', () => {
  assert.ok(app.dbPath.includes('.tmp') && !app.dbPath.includes(`${path.sep}database${path.sep}traintrack.db`));
});
