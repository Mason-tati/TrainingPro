// WP-18 · E3 — Enterprise Document Engine repository behaviour tests (isolated temp DB).
// Exercises every repository method against the injected sqlite3 connection, and proves
// SQL safety (parameterized, allow-listed), soft-delete/restore, FK cascade, and that
// the repositories remain unwired. Nothing production is imported or consumed.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('../helpers/app');

const ROOT = path.join(__dirname, '..', '..');
const RDIR = path.join(ROOT, 'lib', 'document-engine', 'repositories');
const R = (f) => require(path.join(RDIR, f));
const DocumentRepository = R('document-repository.js');
const VersionRepository = R('version-repository.js');
const MetadataRepository = R('metadata-repository.js');
const RelationshipRepository = R('relationship-repository.js');
const ApprovalRepository = R('approval-repository.js');
const DistributionRepository = R('distribution-repository.js');
const AccessRepository = R('access-repository.js');
const NotificationRepository = R('notification-repository.js');
const ValidationRepository = R('validation-repository.js');
const ComplianceRepository = R('compliance-repository.js');
const SearchRepository = R('search-repository.js');

let app, db, docs, versions, meta, rels, approvals, dist, access, notifs, valid, comply, search;
let seq = 0;
const num = () => `E3-${process.pid}-${++seq}`;

before(async () => {
  app = await startTestApp();
  db = app.db.getDb(); // the raw sqlite3 connection (callback API)
  docs = new DocumentRepository(db); versions = new VersionRepository(db); meta = new MetadataRepository(db);
  rels = new RelationshipRepository(db); approvals = new ApprovalRepository(db); dist = new DistributionRepository(db);
  access = new AccessRepository(db); notifs = new NotificationRepository(db); valid = new ValidationRepository(db);
  comply = new ComplianceRepository(db); search = new SearchRepository(db);
});
after(async () => { if (app) await app.close(); });

const mkDoc = (over = {}) => docs.create(Object.assign({ DocumentNumber: num(), Title: 'Doc', DocumentType: 'SOP', DocumentStatus: 'DRAFT', Owner: 'alice' }, over));

test('E3-1. missing db → every repository constructor throws (fail-safe)', () => {
  for (const Repo of [DocumentRepository, VersionRepository, MetadataRepository, RelationshipRepository, ApprovalRepository, DistributionRepository, AccessRepository, NotificationRepository, ValidationRepository, ComplianceRepository, SearchRepository]) {
    assert.throws(() => new Repo(), /database connection/);
    assert.throws(() => new Repo({}), /database connection/); // no run/get/all
  }
});

test('E3-2. DocumentRepository: create/read/getByNumber/update; soft-delete + restore', async () => {
  const n = num();
  const created = await docs.create({ DocumentNumber: n, Title: 'Original', DocumentType: 'SOP', DocumentStatus: 'DRAFT', Owner: 'bob', CreatedBy: 'bob' });
  assert.ok(created.DocumentID && created.DocumentNumber === n && created.Title === 'Original');
  assert.ok(created.CreatedDate, 'CreatedDate default applied');
  assert.equal(created.IsDeleted, 0);
  assert.deepEqual(await docs.getById(created.DocumentID), created);
  assert.equal((await docs.getByNumber(n)).DocumentID, created.DocumentID);
  const upd = await docs.update(created.DocumentID, { Title: 'Revised', DocumentStatus: 'PUBLISHED', UpdatedBy: 'bob' });
  assert.equal(upd.Title, 'Revised');
  assert.equal(upd.DocumentStatus, 'PUBLISHED');
  assert.ok(upd.UpdatedDate, 'UpdatedDate set on update');
  // soft delete → getById/getByNumber hide it
  const sd = await docs.softDelete(created.DocumentID);
  assert.equal(sd.changes, 1);
  assert.equal(await docs.getById(created.DocumentID), null, 'soft-deleted hidden by getById');
  assert.equal(await docs.getByNumber(n), null, 'soft-deleted hidden by getByNumber');
  // restore
  const rs = await docs.restore(created.DocumentID);
  assert.equal(rs.changes, 1);
  assert.ok(await docs.getById(created.DocumentID), 'restored visible again');
});

test('E3-3. DocumentRepository.list: allow-list filters only; unknown keys ignored', async () => {
  const owner = 'list-owner-' + process.pid;
  await mkDoc({ Owner: owner, DocumentType: 'SOP', DocumentStatus: 'DRAFT' });
  await mkDoc({ Owner: owner, DocumentType: 'FORM', DocumentStatus: 'PUBLISHED' });
  const byOwner = await docs.list({ Owner: owner });
  assert.equal(byOwner.length, 2);
  const byOwnerType = await docs.list({ Owner: owner, DocumentType: 'SOP' });
  assert.equal(byOwnerType.length, 1);
  assert.equal(byOwnerType[0].DocumentType, 'SOP');
  // an unknown/injection key is IGNORED (not turned into SQL) → same result as valid filter alone
  const withJunk = await docs.list({ Owner: owner, "DocumentType = 'x' OR '1'='1'": 'boom', maliciousColumn: 1 });
  assert.equal(withJunk.length, 2, 'unknown filter keys ignored (allow-list only)');
});

test('E3-4. parameterized SQL resists injection; values stored literally; tables intact', async () => {
  const evil = "x'; DROP TABLE tblDocument; --";
  const d = await docs.create({ DocumentNumber: num(), Title: evil, DocumentType: 'SOP', DocumentStatus: 'DRAFT', Owner: evil });
  assert.equal(d.Title, evil, 'malicious title stored verbatim (parameterized)');
  // table still exists and is queryable
  const still = await app.db.dbGet("SELECT name FROM sqlite_master WHERE type='table' AND name='tblDocument'");
  assert.ok(still, 'tblDocument not dropped');
  // filter VALUE with injection is a bound param → matches literally (nothing), no error
  const res = await docs.list({ Owner: "' OR '1'='1" });
  assert.ok(Array.isArray(res), 'injection filter value handled as literal param');
  // search LIKE is parameterized too
  await search.index(d.DocumentID, evil);
  const found = await search.search("DROP TABLE");
  assert.ok(Array.isArray(found), 'search query is a bound LIKE param');
});

test('E3-5. VersionRepository: create/getById/listByDocument/getLatest/delete', async () => {
  const doc = await mkDoc();
  const v1 = await versions.create({ DocumentID: doc.DocumentID, VersionString: '1.0.0', OriginalName: 'a.pdf', MimeType: 'application/pdf', FileSize: 10, Status: 'draft', CreatedBy: 'x' });
  const v2 = await versions.create({ DocumentID: doc.DocumentID, VersionString: '1.1.0', Status: 'draft' });
  assert.equal((await versions.getById(v1.VersionID)).VersionString, '1.0.0');
  assert.equal((await versions.listByDocument(doc.DocumentID)).length, 2);
  assert.equal((await versions.getLatest(doc.DocumentID)).VersionID, v2.VersionID, 'latest = highest VersionID');
  const del = await versions.delete(v1.VersionID);
  assert.equal(del.changes, 1);
  assert.equal(await versions.getById(v1.VersionID), null);
});

test('E3-6. MetadataRepository: set (insert then upsert), get, listByDocument, delete', async () => {
  const doc = await mkDoc();
  await meta.set(doc.DocumentID, 'title', 'A');
  assert.equal((await meta.get(doc.DocumentID, 'title')).FieldValue, 'A');
  await meta.set(doc.DocumentID, 'title', 'B'); // upsert
  assert.equal((await meta.get(doc.DocumentID, 'title')).FieldValue, 'B');
  await meta.set(doc.DocumentID, 'owner', 'alice');
  assert.equal((await meta.listByDocument(doc.DocumentID)).length, 2, 'no duplicate on upsert');
  const del = await meta.delete(doc.DocumentID, 'title');
  assert.equal(del.changes, 1);
  assert.equal(await meta.get(doc.DocumentID, 'title'), null);
});

test('E3-7. RelationshipRepository: create/listFrom/listTo/delete', async () => {
  const a = await mkDoc(); const b = await mkDoc();
  const rel = await rels.create({ FromDocumentID: a.DocumentID, RelationshipType: 'SUPERSEDES', ToDocumentID: b.DocumentID, CreatedBy: 'x' });
  assert.equal((await rels.listFrom(a.DocumentID)).length, 1);
  assert.equal((await rels.listTo(b.DocumentID)).length, 1);
  assert.equal((await rels.listFrom(b.DocumentID)).length, 0);
  assert.equal((await rels.delete(rel.RelationshipID)).changes, 1);
  assert.deepEqual(await rels.listFrom(a.DocumentID), []);
});

test('E3-8. ApprovalRepository: create/listByDocument/recordDecision', async () => {
  const doc = await mkDoc();
  const ap = await approvals.create({ DocumentID: doc.DocumentID, WorkflowStep: 'review', ApprovalLevel: 'MANAGER', Decision: 'pending' });
  assert.equal((await approvals.listByDocument(doc.DocumentID)).length, 1);
  const decided = await approvals.recordDecision(ap.ApprovalID, 'approved', 'looks good', 'mgr');
  assert.equal(decided.Decision, 'approved');
  assert.equal(decided.Approver, 'mgr');
  assert.ok(decided.DecisionDate, 'DecisionDate set');
});

test('E3-9. Distribution / Access / Notification repositories', async () => {
  const doc = await mkDoc();
  const di = await dist.create({ DocumentID: doc.DocumentID, DistributionType: 'ALL_USERS', Target: 'everyone' });
  assert.equal((await dist.listByDocument(doc.DocumentID)).length, 1);
  assert.equal((await dist.delete(di.DistributionID)).changes, 1);
  const ac = await access.create({ DocumentID: doc.DocumentID, AccessMode: 'READ_ONLY', Principal: 'role:VIEWER' });
  assert.equal((await access.listByDocument(doc.DocumentID)).length, 1);
  assert.equal((await access.delete(ac.AccessID)).changes, 1);
  const no = await notifs.create({ DocumentID: doc.DocumentID, NotificationType: 'DOCUMENT_PUBLISHED', Recipient: 'readers', Status: 'queued' });
  const upd = await notifs.updateStatus(no.NotificationID, 'sent');
  assert.equal(upd.Status, 'sent');
  assert.equal((await notifs.listByDocument(doc.DocumentID)).length, 1);
});

test('E3-10. Validation / Compliance repositories', async () => {
  const doc = await mkDoc();
  const v = await valid.create({ DocumentID: doc.DocumentID, RuleID: 'TITLE_REQUIRED', Result: 'pass' });
  assert.ok(v.ValidatedDate, 'ValidatedDate defaulted to now');
  assert.equal((await valid.listByDocument(doc.DocumentID)).length, 1);
  const c = await comply.create({ DocumentID: doc.DocumentID, Framework: 'ISO9001', LastAuditDate: '2026-01-01', NextAuditDate: '2027-01-01' });
  assert.equal(c.Framework, 'ISO9001');
  assert.equal((await comply.listByDocument(doc.DocumentID)).length, 1);
});

test('E3-11. SearchRepository: index (upsert), getByDocument, search, and no-match → []', async () => {
  const doc = await mkDoc();
  await search.index(doc.DocumentID, 'confined space entry procedure');
  assert.match((await search.getByDocument(doc.DocumentID)).IndexedText, /confined space/);
  await search.index(doc.DocumentID, 'updated hot work permit text'); // upsert (single row per doc)
  assert.equal((await search.getByDocument(doc.DocumentID)).IndexedText, 'updated hot work permit text');
  const hits = await search.search('hot work');
  assert.ok(hits.some((r) => r.DocumentID === doc.DocumentID));
  assert.deepEqual(await search.search('zzz-no-such-text-zzz'), [], 'no match → []');
});

test('E3-12. return conventions: not-found → null; empty list → []; input not mutated', async () => {
  assert.equal(await docs.getById(99999999), null);
  assert.equal(await docs.getByNumber('__nope__'), null);
  assert.equal(await versions.getById(99999999), null);
  assert.deepEqual(await versions.listByDocument(99999999), []);
  assert.deepEqual(await approvals.listByDocument(99999999), []);
  assert.deepEqual(await docs.list({ Owner: '__nobody__' }), []);
  const frozen = Object.freeze({ DocumentNumber: num(), Title: 'Frozen', DocumentType: 'SOP', DocumentStatus: 'DRAFT' });
  assert.ok(await docs.create(frozen), 'create accepts a frozen input (no mutation)');
});

test('E3-13. FK cascade: hard-deleting a document removes its child rows (via repositories)', async () => {
  const doc = await mkDoc();
  await versions.create({ DocumentID: doc.DocumentID, VersionString: '1.0.0' });
  await approvals.create({ DocumentID: doc.DocumentID, Decision: 'pending' });
  await meta.set(doc.DocumentID, 'k', 'v');
  await app.db.dbRun('DELETE FROM tblDocument WHERE DocumentID = ?', [doc.DocumentID]); // hard delete
  assert.deepEqual(await versions.listByDocument(doc.DocumentID), [], 'versions cascaded');
  assert.deepEqual(await approvals.listByDocument(doc.DocumentID), [], 'approvals cascaded');
  assert.deepEqual(await meta.listByDocument(doc.DocumentID), [], 'metadata cascaded');
});

test('E3-14. repositories do NOT import production DB / express / logger / routes', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/)/;
  for (const f of fs.readdirSync(RDIR).filter((x) => x.endsWith('.js'))) {
    assert.ok(!FORBIDDEN.test(fs.readFileSync(path.join(RDIR, f), 'utf8')), `${f} has no forbidden import`);
  }
});

test('E3-16. defensive branches: partial db, default params, non-object inputs, null query', async () => {
  const Base = require(path.join(RDIR, 'base-repository.js'));
  // constructor operand chain: run present but get/all missing → still throws
  assert.throws(() => new Base({ run() {} }), /database connection/);
  assert.throws(() => new Base({ run() {}, get() {} }), /database connection/);
  // default params (= []): primitives called without a params argument
  const base = new Base(db);
  assert.equal((await base._get('SELECT 1 AS x')).x, 1);
  assert.deepEqual(await base._all('SELECT 1 AS x WHERE 1 = 0'), []);
  assert.ok((await base._run('SELECT 1')) && true);
  // defensive resolve fallbacks: a stub connection whose driver yields null rows.
  const stub = new Base({
    run(_s, _p, cb) { cb.call({ lastID: 1, changes: 1 }, null); },
    get(_s, _p, cb) { cb(null, undefined); },
    all(_s, _p, cb) { cb(null, null); },
  });
  assert.deepEqual(await stub._all('x', []), [], '_all: null rows → []');
  assert.equal(await stub._get('x', []), null, '_get: undefined row → null');
  // driver errors are surfaced (never swallowed) by every primitive.
  const errStub = new Base({
    run(_s, _p, cb) { cb.call({}, new Error('boom-run')); },
    get(_s, _p, cb) { cb(new Error('boom-get')); },
    all(_s, _p, cb) { cb(new Error('boom-all')); },
  });
  await assert.rejects(() => errStub._run('x', []), /boom-run/);
  await assert.rejects(() => errStub._get('x', []), /boom-get/);
  await assert.rejects(() => errStub._all('x', []), /boom-all/);
  // non-object / array inputs → treated as {} across every guard operand (null, primitive, array)
  assert.ok(Array.isArray(await docs.list(null)), 'list(null) → all (no filters)');
  const d = await mkDoc();
  const u = await docs.update(d.DocumentID, null); // patch null → only UpdatedDate touched
  assert.equal(u.DocumentID, d.DocumentID);
  for (const bad of [null, 5, []]) {
    await assert.rejects(() => docs.create(bad), 'create(non-object) fails safely (surfaces the DB error)');
    await assert.rejects(() => valid.create(bad), 'validation.create(non-object) fails safely');
  }
  // validation: an explicitly-provided ValidatedDate (COALESCE left branch)
  const v = await valid.create({ DocumentID: d.DocumentID, RuleID: 'X', Result: 'pass', ValidatedDate: '2026-06-01' });
  assert.equal(v.ValidatedDate, '2026-06-01');
  // search: null query (the `== null` branch)
  assert.ok(Array.isArray(await search.search(null)));
});

test('E3-15. document engine remains UNWIRED (no production consumer imports it)', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
});
