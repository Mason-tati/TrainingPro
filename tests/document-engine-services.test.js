// WP-18 · E4 — Enterprise Document Engine service-layer tests.
// Proves the eleven services are pure orchestrators over injected repositories:
// dependency injection + constructor validation, correct repository call ordering,
// error propagation, input immutability, no SQL / no production imports, and that the
// layer remains completely UNWIRED. Includes one end-to-end smoke test over real
// repositories on an isolated temp DB to confirm the orchestration actually drives SQL.
require('./helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp } = require('./helpers/app');

const ROOT = path.join(__dirname, '..');
const SDIR = path.join(ROOT, 'lib', 'document-engine', 'services');
const RDIR = path.join(ROOT, 'lib', 'document-engine', 'repositories');
const S = (f) => require(path.join(SDIR, f));

// service name → { class, file, injected repository methods, service method → repo method + sample args }
const SERVICES = [
  {
    name: 'DocumentService', file: 'document-service.js', methods: ['create', 'getById', 'update', 'softDelete', 'restore', 'list'],
    ops: [
      { m: 'createDocument', args: [{ Title: 't' }], repo: 'create' },
      { m: 'getDocument', args: [7], repo: 'getById' },
      { m: 'updateDocument', args: [7, { Title: 'u' }], repo: 'update' },
      { m: 'deleteDocument', args: [7], repo: 'softDelete' },
      { m: 'restoreDocument', args: [7], repo: 'restore' },
      { m: 'listDocuments', args: [{ Owner: 'o' }], repo: 'list' },
    ],
  },
  {
    name: 'VersionService', file: 'version-service.js', methods: ['create', 'getLatest', 'listByDocument'],
    ops: [
      { m: 'createVersion', args: [{ DocumentID: 7 }], repo: 'create' },
      { m: 'getLatestVersion', args: [7], repo: 'getLatest' },
      { m: 'listVersions', args: [7], repo: 'listByDocument' },
    ],
  },
  {
    name: 'MetadataService', file: 'metadata-service.js', methods: ['set', 'get'],
    ops: [
      { m: 'setMetadata', args: [7, 'field', 'value'], repo: 'set' },
      { m: 'getMetadata', args: [7, 'field'], repo: 'get' },
    ],
  },
  {
    name: 'RelationshipService', file: 'relationship-service.js', methods: ['create', 'delete'],
    ops: [
      { m: 'linkDocuments', args: [{ FromDocumentID: 1, ToDocumentID: 2 }], repo: 'create' },
      { m: 'unlinkDocuments', args: [5], repo: 'delete' },
    ],
  },
  {
    name: 'ApprovalService', file: 'approval-service.js', methods: ['create', 'recordDecision'],
    ops: [
      { m: 'createApproval', args: [{ DocumentID: 7 }], repo: 'create' },
      { m: 'recordApprovalDecision', args: [3, 'approved', 'ok', 'bob'], repo: 'recordDecision' },
    ],
  },
  {
    name: 'DistributionService', file: 'distribution-service.js', methods: ['create'],
    ops: [{ m: 'createDistribution', args: [{ DocumentID: 7 }], repo: 'create' }],
  },
  {
    name: 'AccessService', file: 'access-service.js', methods: ['create'],
    ops: [{ m: 'grantAccess', args: [{ DocumentID: 7 }], repo: 'create' }],
  },
  {
    name: 'NotificationService', file: 'notification-service.js', methods: ['create'],
    ops: [{ m: 'createNotification', args: [{ DocumentID: 7 }], repo: 'create' }],
  },
  {
    name: 'ValidationService', file: 'validation-service.js', methods: ['create'],
    ops: [{ m: 'validateDocument', args: [{ DocumentID: 7 }], repo: 'create' }],
  },
  {
    name: 'ComplianceService', file: 'compliance-service.js', methods: ['create'],
    ops: [{ m: 'recordCompliance', args: [{ DocumentID: 7 }], repo: 'create' }],
  },
  {
    name: 'SearchService', file: 'search-service.js', methods: ['index', 'search'],
    ops: [
      { m: 'indexDocument', args: [7, 'text'], repo: 'index' },
      { m: 'searchDocuments', args: ['query'], repo: 'search' },
    ],
  },
];
for (const s of SERVICES) s.klass = S(s.file);

// A recording mock repository: every listed method records its call and resolves to a
// unique sentinel, so we can assert both the call arguments and the pass-through return.
function mockRepo(methods, { rejectOn } = {}) {
  const calls = [];
  const repo = {};
  for (const m of methods) {
    repo[m] = (...args) => {
      calls.push({ method: m, args });
      if (rejectOn === m) return Promise.reject(new Error(`repo-fail:${m}`));
      return Promise.resolve({ __sentinel: m });
    };
  }
  return { repo, calls };
}

test('E4-1. constructor validation: missing / invalid / incomplete repository throws; valid injects', () => {
  for (const s of SERVICES) {
    assert.throws(() => new s.klass(), /requires an injected repository/, `${s.name}() throws without a repository`);
    assert.throws(() => new s.klass(null), /requires an injected repository/, `${s.name}(null) throws`);
    assert.throws(() => new s.klass(5), /requires an injected repository/, `${s.name}(primitive) throws`);
    // a repository missing any required method is rejected (fail-safe contract check)
    for (const missing of s.methods) {
      const partial = mockRepo(s.methods.filter((x) => x !== missing)).repo;
      assert.throws(() => new s.klass(partial), new RegExp(`implement ${missing}\\(\\)`), `${s.name} rejects repo missing ${missing}`);
    }
    const svc = new s.klass(mockRepo(s.methods).repo);
    assert.ok(svc && typeof svc === 'object', `${s.name} accepts a complete injected repository`);
  }
});

test('E4-2. dependency injection + orchestration + correct call ordering + pass-through return', async () => {
  for (const s of SERVICES) {
    for (const op of s.ops) {
      const { repo, calls } = mockRepo(s.methods);
      const svc = new s.klass(repo);
      const result = await svc[op.m](...op.args);
      // exactly one repository call, to the expected method, with the exact arguments
      assert.equal(calls.length, 1, `${s.name}.${op.m} makes exactly one repository call`);
      assert.equal(calls[0].method, op.repo, `${s.name}.${op.m} → repository.${op.repo}`);
      assert.deepEqual(calls[0].args, op.args, `${s.name}.${op.m} forwards its arguments verbatim`);
      // the service returns the repository result unchanged (plain object)
      assert.deepEqual(result, { __sentinel: op.repo }, `${s.name}.${op.m} returns the repository result`);
    }
  }
});

test('E4-3. repository failures propagate (never swallowed)', async () => {
  for (const s of SERVICES) {
    for (const op of s.ops) {
      const { repo } = mockRepo(s.methods, { rejectOn: op.repo });
      const svc = new s.klass(repo);
      await assert.rejects(() => svc[op.m](...op.args), new RegExp(`repo-fail:${op.repo}`), `${s.name}.${op.m} propagates the repository error`);
    }
  }
});

test('E4-4. input immutability: object arguments are neither mutated nor copied away', async () => {
  for (const s of SERVICES) {
    for (const op of s.ops) {
      const objIdx = op.args.findIndex((a) => a && typeof a === 'object');
      if (objIdx === -1) continue;
      const frozen = Object.freeze({ ...op.args[objIdx] });
      const snapshot = { ...frozen };
      const { repo, calls } = mockRepo(s.methods);
      const svc = new s.klass(repo);
      const args = op.args.slice();
      args[objIdx] = frozen;
      await svc[op.m](...args); // must not attempt to mutate a frozen input
      assert.deepEqual(frozen, snapshot, `${s.name}.${op.m} does not mutate its input object`);
      assert.equal(calls[0].args[objIdx], frozen, `${s.name}.${op.m} forwards the same reference (no lossy copy)`);
    }
  }
});

test('E4-5. no SQL inside services (repositories are the only SQL layer)', () => {
  const SQL = /SELECT\s|INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+tbl|\btblDocument|this\.db|VALUES\s*\(|PRAGMA\s/i;
  const files = fs.readdirSync(SDIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(SDIR, f), 'utf8');
    assert.ok(!SQL.test(src), `${f} contains no SQL / table references / db handle`);
  }
});

test('E4-6. no production imports (db / express / routes / logger / request-context / server)', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server)/;
  const files = fs.readdirSync(SDIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = fs.readFileSync(path.join(SDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    // services import only the sibling base-service (or nothing)
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\/base-service\1\)/.test(r), `${f} only requires ./base-service (found ${r})`);
    }
  }
});

test('E4-7. service layer is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});

test('E4-8. services never instantiate repositories internally (DI only)', () => {
  const files = fs.readdirSync(SDIR).filter((f) => f.endsWith('.js') && f !== 'base-service.js');
  for (const f of files) {
    const src = fs.readFileSync(path.join(SDIR, f), 'utf8');
    assert.ok(!/new\s+\w*Repository\b/.test(src), `${f} does not construct a repository`);
    assert.ok(!/repositories\//.test(src), `${f} does not reach into the repositories directory`);
  }
});

// ---- end-to-end smoke: services orchestrating REAL repositories over an isolated temp DB ----
let app, db;
before(async () => { app = await startTestApp(); db = app.db.getDb(); });
after(async () => { if (app) await app.close(); });

test('E4-9. end-to-end: services drive real repositories against a temp DB', async () => {
  const R = (f) => require(path.join(RDIR, f));
  const docs = new (S('document-service.js'))(new (R('document-repository.js'))(db));
  const versions = new (S('version-service.js'))(new (R('version-repository.js'))(db));
  const metaSvc = new (S('metadata-service.js'))(new (R('metadata-repository.js'))(db));
  const searchSvc = new (S('search-service.js'))(new (R('search-repository.js'))(db));
  const approvals = new (S('approval-service.js'))(new (R('approval-repository.js'))(db));

  const created = await docs.createDocument({ DocumentNumber: `E4-${process.pid}-1`, Title: 'Smoke', DocumentType: 'SOP', DocumentStatus: 'DRAFT' });
  assert.ok(created.DocumentID, 'document created via service');
  const fetched = await docs.getDocument(created.DocumentID);
  assert.equal(fetched.Title, 'Smoke');

  await versions.createVersion({ DocumentID: created.DocumentID, VersionString: '1.0.0' });
  const latest = await versions.getLatestVersion(created.DocumentID);
  assert.equal(latest.VersionString, '1.0.0');

  const meta = await metaSvc.setMetadata(created.DocumentID, 'owner', 'alice');
  assert.equal(meta.FieldValue, 'alice');
  assert.equal((await metaSvc.getMetadata(created.DocumentID, 'owner')).FieldValue, 'alice');

  await searchSvc.indexDocument(created.DocumentID, 'smoke test document');
  assert.equal((await searchSvc.searchDocuments('smoke')).length >= 1, true);
  assert.deepEqual(await searchSvc.searchDocuments('no-such-token-xyz'), []);

  const appr = await approvals.createApproval({ DocumentID: created.DocumentID, Decision: 'pending' });
  const decided = await approvals.recordApprovalDecision(appr.ApprovalID, 'approved', 'looks good', 'bob');
  assert.equal(decided.Decision, 'approved');

  // soft-delete then restore through the service
  await docs.deleteDocument(created.DocumentID);
  assert.equal(await docs.getDocument(created.DocumentID), null, 'soft-deleted document is not returned');
  await docs.restoreDocument(created.DocumentID);
  assert.ok((await docs.getDocument(created.DocumentID)), 'restored document is returned again');
});
