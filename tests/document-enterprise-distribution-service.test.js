// WP-26 · Phase 6 — Enterprise Document Distribution service tests (business rules; ephemeral DB).
// Covers version existence (via injected version repo), recipient (user/group) validation, mandatory-
// read validation, acknowledgement, notification tracking, outstanding + completion calculation, and
// never-throw behaviour.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const EDIR = path.join(__dirname, '..', 'lib', 'document-engine', 'enterprise');
const XMig = require(path.join(EDIR, 'enterprise-document-distribution-migration.js'));
const XRepo = require(path.join(EDIR, 'enterprise-document-distribution-repository.js'));
const Service = require(path.join(EDIR, 'enterprise-document-distribution-service.js'));
const VMig = require(path.join(EDIR, 'enterprise-document-version-migration.js'));
const VRepo = require(path.join(EDIR, 'enterprise-document-version-repository.js'));
const VSvc = require(path.join(EDIR, 'enterprise-document-version-service.js'));
const DMig = require(path.join(EDIR, 'enterprise-document-core-migration.js'));
const DRepo = require(path.join(EDIR, 'enterprise-document-core-repository.js'));
const DSvc = require(path.join(EDIR, 'enterprise-document-core-service.js'));
const FMig = require(path.join(EDIR, 'enterprise-folder-migration.js'));
const FRepo = require(path.join(EDIR, 'enterprise-folder-repository.js'));

const REPO_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findPending', 'findAcknowledged', 'findOutstanding', 'archive', 'restore', 'softDelete', 'exists', 'count'];

async function freshService() {
  const db = new sqlite3.Database(':memory:');
  await XMig.migrate(db); await VMig.migrate(db); await DMig.migrate(db); await FMig.migrate(db);
  const verRepo = new VRepo(db); const docRepo = new DRepo(db);
  const doc = await new DSvc(docRepo, new FRepo(db)).createDocument({ documentNumber: 'DOC-1', documentTitle: 'Spec' });
  const ver = await new VSvc(verRepo, docRepo).createVersion({ documentId: doc.document.id });
  const svc = new Service(new XRepo(db), verRepo);
  return { db, svc, verId: ver.version.id };
}
function throwingService(method, err) {
  const repo = {};
  for (const m of REPO_METHODS) repo[m] = () => { throw new Error('unexpected'); };
  repo[method] = () => { throw err; };
  return new Service(repo, { findById() { return { id: 1 }; } });
}

// ---- construction ----

test('W26X-SVC-1. constructor validates the distribution repo AND requires a version repository', () => {
  const goodRepo = {};
  for (const m of REPO_METHODS) goodRepo[m] = () => {};
  assert.throws(() => new Service({}, { findById() {} }), /Injected repository must implement/);
  assert.throws(() => new Service(goodRepo, {}), /requires an injected version repository/);
  assert.throws(() => new Service(goodRepo, null), /requires an injected version repository/);
});

// ---- create: version + recipient ----

test('W26X-SVC-2. createDistribution requires an existing version', async () => {
  const { db, svc } = await freshService();
  assert.equal((await svc.createDistribution(null)).code, 'VALIDATION');
  assert.equal((await svc.createDistribution({ userId: 1 })).code, 'VALIDATION', 'missing versionId (undefined)');
  assert.equal((await svc.createDistribution({ documentVersionId: null, userId: 1 })).code, 'VALIDATION', 'null versionId');
  assert.equal((await svc.createDistribution({ documentVersionId: 9999, userId: 1 })).code, 'VALIDATION', 'unknown version');
  db.close();
});

test('W26X-SVC-3. recipient validation: at least one of userId/distributionGroupId is required', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createDistribution({ documentVersionId: verId })).code, 'VALIDATION', 'no recipient');
  assert.equal((await svc.createDistribution({ documentVersionId: verId, userId: 0 })).code, 'VALIDATION', 'invalid userId');
  assert.equal((await svc.createDistribution({ documentVersionId: verId, distributionGroupId: 0 })).code, 'VALIDATION', 'invalid group');
  db.close();
});

test('W26X-SVC-4. recipient may be a user, a group, or (null one + valid other)', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.createDistribution({ documentVersionId: verId, userId: 100 })).ok, true, 'user only');
  assert.equal((await svc.createDistribution({ documentVersionId: verId, distributionGroupId: 5 })).ok, true, 'group only');
  assert.equal((await svc.createDistribution({ documentVersionId: verId, userId: null, distributionGroupId: 6 })).ok, true, 'null user + group');
  assert.equal((await svc.createDistribution({ documentVersionId: verId, userId: 101, distributionGroupId: null })).ok, true, 'user + null group');
  db.close();
});

test('W26X-SVC-5. create validates type / method / status / mandatoryRead / metadata', async () => {
  const { db, svc, verId } = await freshService();
  const base = { documentVersionId: verId, userId: 1 };
  assert.equal((await svc.createDistribution({ ...base, distributionType: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.createDistribution({ ...base, deliveryMethod: 'PIGEON' })).code, 'VALIDATION');
  assert.equal((await svc.createDistribution({ ...base, distributionStatus: 'HUH' })).code, 'VALIDATION');
  assert.equal((await svc.createDistribution({ ...base, mandatoryRead: 2 })).code, 'VALIDATION');
  assert.equal((await svc.createDistribution({ ...base, metadata: 'no' })).code, 'VALIDATION');
  db.close();
});

test('W26X-SVC-6. create (minimal) applies defaults; (full) persists fields + parses metadata', async () => {
  const { db, svc, verId } = await freshService();
  const min = (await svc.createDistribution({ documentVersionId: verId, userId: 1 })).distribution;
  assert.equal(min.distributionType, 'INDIVIDUAL');
  assert.equal(min.deliveryMethod, 'PORTAL');
  assert.equal(min.distributionStatus, 'PENDING');
  assert.equal(min.mandatoryRead, 0);
  assert.equal(min.acknowledged, 0);
  assert.equal(min.metadata, null);
  const full = (await svc.createDistribution({
    documentVersionId: verId, userId: 2, distributionType: 'GROUP', deliveryMethod: 'EMAIL',
    distributionStatus: 'SENT', sentDate: '2026-01-01', receivedDate: '2026-01-02', expiryDate: '2026-12-31',
    mandatoryRead: 1, metadata: { a: 1 },
  })).distribution;
  assert.equal(full.deliveryMethod, 'EMAIL');
  assert.equal(full.mandatoryRead, 1);
  assert.deepEqual(full.metadata, { a: 1 });
  const raw = (await svc.createDistribution({ documentVersionId: verId, userId: 3, metadataJson: '{"x":1}' })).distribution;
  assert.deepEqual(raw.metadata, { x: 1 });
  db.close();
});

// ---- read / queries ----

test('W26X-SVC-7. getDistribution found / NOT_FOUND; corrupt metadata tolerated', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  assert.equal((await svc.getDistribution(created.distribution.id)).ok, true);
  assert.equal((await svc.getDistribution(9999)).code, 'NOT_FOUND');
  const repo = new XRepo(db);
  const bad = await repo.create({ documentVersionId: verId, userId: 9, metadataJson: '{oops' });
  assert.equal((await svc.getDistribution(bad.id)).distribution.metadata, null);
  db.close();
});

test('W26X-SVC-8. listVersionDistributions / pendingDistributions / outstandingDistributions', async () => {
  const { db, svc, verId } = await freshService();
  const a = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  await svc.createDistribution({ documentVersionId: verId, userId: 2 });
  await svc.acknowledgeDistribution(a.distribution.id);
  assert.equal((await svc.listVersionDistributions(verId)).distributions.length, 2);
  assert.equal((await svc.pendingDistributions()).distributions.length, 1, 'the un-acknowledged (still PENDING)');
  assert.equal((await svc.outstandingDistributions()).distributions.length, 1, 'un-acknowledged');
  db.close();
});

// ---- update ----

test('W26X-SVC-9. updateDistribution NOT_FOUND / validation / success', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.updateDistribution(4242, { deliveryMethod: 'EMAIL' })).code, 'NOT_FOUND');
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  const id = created.distribution.id;
  assert.equal((await svc.updateDistribution(id, { distributionType: 'NOPE' })).code, 'VALIDATION');
  assert.equal((await svc.updateDistribution(id, { deliveryMethod: 'PIGEON' })).code, 'VALIDATION');
  assert.equal((await svc.updateDistribution(id, { distributionStatus: 'HUH' })).code, 'VALIDATION');
  assert.equal((await svc.updateDistribution(id, { mandatoryRead: 5 })).code, 'VALIDATION');
  assert.equal((await svc.updateDistribution(id, { metadata: 7 })).code, 'VALIDATION');
  const upd = await svc.updateDistribution(id, { deliveryMethod: 'SMS', mandatoryRead: 1, metadata: { r: 1 } });
  assert.equal(upd.distribution.deliveryMethod, 'SMS');
  assert.deepEqual(upd.distribution.metadata, { r: 1 });
  assert.equal((await svc.updateDistribution(id, null)).ok, true, 'non-object patch → no-op success');
  db.close();
});

// ---- acknowledgement ----

test('W26X-SVC-10. acknowledgeDistribution: NOT_FOUND / success / already-acknowledged', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.acknowledgeDistribution(9999)).code, 'NOT_FOUND');
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  const id = created.distribution.id;
  const ack = await svc.acknowledgeDistribution(id);
  assert.equal(ack.distribution.acknowledged, 1);
  assert.equal(ack.distribution.distributionStatus, 'ACKNOWLEDGED');
  assert.ok(ack.distribution.acknowledgedDate);
  assert.equal((await svc.acknowledgeDistribution(id)).code, 'VALIDATION', 'already acknowledged');
  db.close();
});

// ---- notification tracking ----

test('W26X-SVC-11. recordNotification: increments count + stamps date; NOT_FOUND; blocked when acknowledged', async () => {
  const { db, svc, verId } = await freshService();
  assert.equal((await svc.recordNotification(9999)).code, 'NOT_FOUND');
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  const id = created.distribution.id;
  const n1 = await svc.recordNotification(id);
  assert.equal(n1.distribution.notificationCount, 1);
  assert.ok(n1.distribution.lastNotificationDate);
  assert.equal((await svc.recordNotification(id)).distribution.notificationCount, 2);
  await svc.acknowledgeDistribution(id);
  assert.equal((await svc.recordNotification(id)).code, 'VALIDATION', 'cannot notify acknowledged');
  db.close();
});

// ---- outstanding / completion calculation ----

test('W26X-SVC-12. getDistributionCompletion: empty, partial, mandatory-outstanding, and full', async () => {
  const { db, svc, verId } = await freshService();
  assert.deepEqual(await svc.getDistributionCompletion(verId), { ok: true, complete: false, total: 0, acknowledged: 0, outstanding: 0, mandatoryOutstanding: 0 });
  const m1 = await svc.createDistribution({ documentVersionId: verId, userId: 1, mandatoryRead: 1 }); // mandatory, unack
  const m2 = await svc.createDistribution({ documentVersionId: verId, userId: 2, mandatoryRead: 1 }); // mandatory, will ack
  await svc.createDistribution({ documentVersionId: verId, userId: 3, mandatoryRead: 0 });            // non-mandatory
  await svc.acknowledgeDistribution(m2.distribution.id);
  const partial = await svc.getDistributionCompletion(verId);
  assert.deepEqual(partial, { ok: true, complete: false, total: 3, acknowledged: 1, outstanding: 2, mandatoryOutstanding: 1 });
  await svc.acknowledgeDistribution(m1.distribution.id);
  const list = await svc.listVersionDistributions(verId);
  for (const d of list.distributions) { if (d.acknowledged === 0) await svc.acknowledgeDistribution(d.id); }
  const full = await svc.getDistributionCompletion(verId);
  assert.equal(full.complete, true);
  assert.equal(full.acknowledged, 3);
  db.close();
});

// ---- lifecycle ----

test('W26X-SVC-13. archiveDistribution success / NOT_FOUND / already-archived', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  const id = created.distribution.id;
  assert.equal((await svc.archiveDistribution(id)).distribution.archived, 1);
  assert.equal((await svc.archiveDistribution(id)).code, 'VALIDATION');
  assert.equal((await svc.archiveDistribution(9999)).code, 'NOT_FOUND');
  db.close();
});

test('W26X-SVC-14. deleteDistribution success then NOT_FOUND on re-delete', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  const id = created.distribution.id;
  assert.equal((await svc.deleteDistribution(id)).ok, true);
  assert.equal((await svc.deleteDistribution(id)).code, 'NOT_FOUND');
  db.close();
});

test('W26X-SVC-15. restoreDistribution restores a soft-deleted row; NOT_FOUND for unknown id', async () => {
  const { db, svc, verId } = await freshService();
  const created = await svc.createDistribution({ documentVersionId: verId, userId: 1 });
  const id = created.distribution.id;
  await svc.deleteDistribution(id);
  const restored = await svc.restoreDistribution(id);
  assert.equal(restored.ok, true);
  assert.equal(restored.distribution.deleted, 0);
  assert.equal((await svc.restoreDistribution(9999)).code, 'NOT_FOUND');
  db.close();
});

// ---- never-throw ----

test('W26X-SVC-16. unexpected repository error → { ok:false, code:ERROR } (message kept)', async () => {
  const svc = throwingService('findById', new Error('db exploded'));
  const r = await svc.getDistribution(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'db exploded');
});

test('W26X-SVC-17. error without a message → generic ERROR string', async () => {
  const svc = throwingService('findByVersion', 'boom-string');
  const r = await svc.getDistributionCompletion(1);
  assert.equal(r.code, 'ERROR');
  assert.equal(r.error, 'ERROR');
});
