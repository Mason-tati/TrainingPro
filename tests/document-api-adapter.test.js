// WP-19 · E3 — Enterprise API Adapter Foundation tests.
// Verifies the API adapter is a pure stateless façade that delegates every API-style method to
// the Repository Adapter, returns fresh copies (copy-on-read), is deterministic, never throws
// under hostile inputs, exposes the exact 19-method surface, and is unwired (no Express/routes).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const API = require(path.join(EDIR, 'api-adapter.js'));
const repo = require(path.join(EDIR, 'repository-adapter.js'));
const builder = require(path.join(EDIR, 'document-builder.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const eq = (a, b) => assert.deepEqual(a, b);

// ---------------------------------------------------------------------------
// delegation: deep equality with the repository adapter
// ---------------------------------------------------------------------------

test('E3-1. createDocument delegates to repo.create', () => {
  const input = { title: 'A', documentType: 'SOP', metadata: { Owner: 'x' } };
  const opts = { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } } };
  eq(API.createDocument(input, opts), repo.create(input, opts));
  assert.equal(API.createDocument({ title: 'X' }, { numbering: { template: 'D-{SEQUENCE}' } }).documentNumber, 'D-000001');
});

test('E3-2. updateDocument delegates to repo.update', () => {
  eq(API.updateDocument({ a: 1 }, { b: 2 }), repo.update({ a: 1 }, { b: 2 }));
  eq(API.updateDocument({ t: [1] }, { t: [2] }, { arrays: 'union' }), repo.update({ t: [1] }, { t: [2] }, { arrays: 'union' }));
});

test('E3-3. read-style getDocument / listDocuments / searchDocuments / restoreDocument / deleteDocument / cloneDocument delegate', () => {
  const doc = { a: { b: 1 }, arr: [1, 2] };
  eq(API.getDocument(doc), repo.get(doc));
  eq(API.listDocuments(doc), repo.list(doc));
  eq(API.searchDocuments(doc), repo.search(doc));
  eq(API.restoreDocument(doc), repo.restore(doc));
  eq(API.deleteDocument(doc), repo.delete(doc));
  eq(API.cloneDocument(doc), repo.clone(doc));
  assert.notEqual(API.getDocument(doc), doc);
  assert.notEqual(API.getDocument(doc).a, doc.a);
});

test('E3-4. validateDocument delegates to repo.validate', () => {
  const doc = builder.createDocument({ title: 'X' });
  eq(API.validateDocument(doc), repo.validate(doc));
  const v = API.validateDocument(doc);
  assert.ok('valid' in v && 'errors' in v && 'warnings' in v);
  assert.equal(API.validateDocument(5).valid, false);
});

test('E3-5. snapshotDocument delegates to repo.snapshot', () => {
  const doc = builder.createDocument({ title: 'Snap', metadata: { a: 1 } });
  const s = API.snapshotDocument(doc);
  eq(s, repo.snapshot(doc));
  assert.equal(s.schema, 'enterprise-document.v1');
  assert.equal(s.digest, repo.snapshot(doc).digest);
});

test('E3-6. archiveDocument delegates to repo.archive (immutability) without freezing caller', () => {
  const src = { title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] };
  const frozen = API.archiveDocument(src);
  eq(frozen, repo.archive(src));
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.relationships[0]));
  assert.equal(Object.isFrozen(src), false);
});

test('E3-7. versionDocument / approveDocument / reviewDocument delegate', () => {
  eq(API.versionDocument({ scheme: 'SEMANTIC', major: 1 }), repo.version({ scheme: 'SEMANTIC', major: 1 }));
  eq(API.approveDocument({ workflow: 'NONE' }), repo.approve({ workflow: 'NONE' }));
  eq(API.reviewDocument({ workflow: 'NONE' }), repo.review({ workflow: 'NONE' }));
});

test('E3-8. accessDocument / storageDocument / complianceDocument delegate', () => {
  eq(API.accessDocument({ accessType: 'REVIEWER', permissions: ['read'] }), repo.access({ accessType: 'REVIEWER', permissions: ['read'] }));
  eq(API.storageDocument({ storageType: 'LOCAL_PRIVATE' }), repo.storage({ storageType: 'LOCAL_PRIVATE' }));
  eq(API.complianceDocument({ framework: 'ISO9001' }), repo.compliance({ framework: 'ISO9001' }));
});

// ---------------------------------------------------------------------------
// information façade
// ---------------------------------------------------------------------------

test('E3-9. health delegates + deterministic + copy-on-read', () => {
  eq(API.health(), repo.health());
  const h = API.health();
  assert.equal(h.healthy, true);
  assert.equal(h.modulesLoaded, 11);
  assert.deepEqual(API.health(), API.health());
  assert.notEqual(API.health(), API.health());
  assert.notEqual(API.health().modulesAvailable, API.health().modulesAvailable);
});

test('E3-10. capabilities delegates + full list + copy-on-read', () => {
  eq(API.capabilities(), repo.capabilities());
  const names = API.capabilities().map((c) => c.name);
  for (const cap of ['Numbering', 'Metadata', 'Policy', 'Assembly', 'Versioning', 'Approval', 'Review', 'Access', 'Storage', 'Compliance', 'Validation', 'Snapshots', 'Comparison', 'Normalization', 'Cloning', 'Immutability']) {
    assert.ok(names.includes(cap), `capability ${cap}`);
  }
  assert.ok(API.capabilities().every((c) => c.supported === true));
  assert.notEqual(API.capabilities(), API.capabilities());
  assert.notEqual(API.capabilities()[0], API.capabilities()[0]);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E3-11. export surface is exact (19 API-style methods)', () => {
  assert.deepEqual(Object.keys(API).sort(), [
    'accessDocument', 'approveDocument', 'archiveDocument', 'capabilities', 'cloneDocument', 'complianceDocument',
    'createDocument', 'deleteDocument', 'getDocument', 'health', 'listDocuments', 'restoreDocument', 'reviewDocument',
    'searchDocuments', 'snapshotDocument', 'storageDocument', 'updateDocument', 'validateDocument', 'versionDocument',
  ]);
});

test('E3-12. every export is a function', () => {
  for (const k of Object.keys(API)) assert.equal(typeof API[k], 'function', `${k} is a function`);
});

test('E3-13. copy-on-read: API adapter never mutates caller inputs', () => {
  const input = Object.freeze({ title: '  T  ', metadata: Object.freeze({ a: 1 }) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => API.createDocument(input, { numbering: { template: 'D-{SEQUENCE}' } }), 'createDocument');
  noThrow(() => API.getDocument(input), 'getDocument');
  noThrow(() => API.updateDocument(input, { x: 1 }), 'updateDocument');
  noThrow(() => API.archiveDocument(input), 'archiveDocument');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
});

test('E3-14. fresh object every call (no shared references)', () => {
  const input = { a: { b: 1 } };
  const r1 = API.getDocument(input);
  const r2 = API.getDocument(input);
  assert.notEqual(r1, r2);
  assert.notEqual(r1.a, r2.a);
  r1.a.b = 999;
  assert.equal(API.getDocument(input).a.b, 1);
});

test('E3-15. never throws: single-argument methods tolerate hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { a: {} }];
  for (const a of hostile) {
    for (const fn of ['getDocument', 'listDocuments', 'searchDocuments', 'restoreDocument', 'deleteDocument', 'cloneDocument', 'validateDocument', 'snapshotDocument', 'archiveDocument']) {
      noThrow(() => API[fn](a), `API.${fn}`);
    }
  }
});

test('E3-16. never throws: multi-argument + component methods tolerate hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { title: {} }, { template: 5 }];
  for (const a of hostile) {
    noThrow(() => API.createDocument(a, a), 'API.createDocument');
    noThrow(() => API.updateDocument(a, a, a), 'API.updateDocument');
    for (const fn of ['versionDocument', 'approveDocument', 'reviewDocument', 'accessDocument', 'storageDocument', 'complianceDocument']) {
      noThrow(() => API[fn](a, a), `API.${fn}`);
    }
  }
  noThrow(() => API.health(), 'API.health');
  noThrow(() => API.capabilities(), 'API.capabilities');
});

test('E3-17. deterministic: identical inputs produce identical API output', () => {
  assert.deepEqual(API.getDocument({ a: 1 }), API.getDocument({ a: 1 }));
  assert.deepEqual(API.createDocument({ title: 'Z' }), API.createDocument({ title: 'Z' }));
  assert.deepEqual(API.complianceDocument({ framework: 'ISO9001' }), API.complianceDocument({ framework: 'ISO9001' }));
  assert.equal(API.snapshotDocument(builder.createDocument({ title: 'Z' })).digest, API.snapshotDocument(builder.createDocument({ title: 'Z' })).digest);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E3-18. API adapter imports ONLY the sibling repository-adapter', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const src = fs.readFileSync(path.join(EDIR, 'api-adapter.js'), 'utf8');
  assert.ok(!FORBIDDEN.test(src), 'no forbidden production import');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  assert.ok(/require\((['"])\.\/repository-adapter\1\)/.test(requires[0]), `only ./repository-adapter (found ${requires[0]})`);
});

test('E3-19. no Express / route / HTTP tokens in the API adapter source', () => {
  const src = fs.readFileSync(path.join(EDIR, 'api-adapter.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/\b(app\.(get|post|put|delete|use)|router\.|createServer|listen\()/.test(src), 'no HTTP/route wiring');
});

test('E3-20. API adapter is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
