// WP-19 · E2 — Enterprise Repository Adapter Foundation tests.
// Verifies the adapter is a pure stateless delegation layer that maps repository-style verbs
// onto the Enterprise Document Service, returns fresh copies (copy-on-read), is deterministic,
// never throws under hostile inputs, exposes the exact 19-method surface, and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const A = require(path.join(EDIR, 'repository-adapter.js'));
const S = require(path.join(EDIR, 'document-service.js'));
const builder = require(path.join(EDIR, 'document-builder.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const eq = (a, b) => assert.deepEqual(a, b);

// ---------------------------------------------------------------------------
// delegation: deep equality with the underlying service
// ---------------------------------------------------------------------------

test('E2-1. create delegates to service.assembleDocument', () => {
  const input = { title: 'A', documentType: 'SOP', metadata: { Owner: 'x' } };
  const opts = { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } } };
  eq(A.create(input, opts), S.assembleDocument(input, opts));
  assert.equal(A.create({ title: 'X' }, { numbering: { template: 'D-{SEQUENCE}' } }).documentNumber, 'D-000001');
});

test('E2-2. update delegates to service.mergeDocument', () => {
  eq(A.update({ a: 1 }, { b: 2 }), S.mergeDocument({ a: 1 }, { b: 2 }));
  eq(A.update({ t: [1] }, { t: [2] }, { arrays: 'union' }), S.mergeDocument({ t: [1] }, { t: [2] }, { arrays: 'union' }));
});

test('E2-3. read-style get / list / search / restore / delete delegate to cloneDocument (copy-on-read)', () => {
  const doc = { a: { b: 1 }, arr: [1, 2] };
  for (const m of ['get', 'list', 'search', 'restore', 'delete', 'clone']) {
    eq(A[m](doc), S.cloneDocument(doc));
  }
  // fresh copies, not the same reference
  assert.notEqual(A.get(doc), doc);
  assert.notEqual(A.get(doc).a, doc.a);
});

test('E2-4. validate delegates to service.validateDocument', () => {
  const doc = builder.createDocument({ title: 'X' });
  eq(A.validate(doc), S.validateDocument(doc));
  const v = A.validate(doc);
  assert.ok('valid' in v && 'errors' in v && 'warnings' in v);
  assert.equal(A.validate(5).valid, false);
});

test('E2-5. snapshot delegates to service.generateDocumentSnapshot', () => {
  const doc = builder.createDocument({ title: 'Snap', metadata: { a: 1 } });
  const s = A.snapshot(doc);
  eq(s, S.generateDocumentSnapshot(doc));
  assert.equal(s.schema, 'enterprise-document.v1');
  assert.equal(s.digest, S.generateDocumentSnapshot(doc).digest);
});

test('E2-6. archive delegates to service.freezeDocument (immutability) without freezing caller', () => {
  const src = { title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] };
  const frozen = A.archive(src);
  eq(frozen, S.freezeDocument(src));
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.relationships[0]));
  assert.equal(Object.isFrozen(src), false);
});

test('E2-7. version / approve / review delegate', () => {
  eq(A.version({ scheme: 'SEMANTIC', major: 1 }), S.createVersion({ scheme: 'SEMANTIC', major: 1 }));
  eq(A.approve({ workflow: 'NONE' }), S.createApproval({ workflow: 'NONE' }));
  eq(A.review({ workflow: 'NONE' }), S.createReview({ workflow: 'NONE' }));
});

test('E2-8. access / storage / compliance delegate', () => {
  eq(A.access({ accessType: 'REVIEWER', permissions: ['read'] }), S.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }));
  eq(A.storage({ storageType: 'LOCAL_PRIVATE' }), S.createStorage({ storageType: 'LOCAL_PRIVATE' }));
  eq(A.compliance({ framework: 'ISO9001' }), S.createCompliance({ framework: 'ISO9001' }));
});

// ---------------------------------------------------------------------------
// information façade
// ---------------------------------------------------------------------------

test('E2-9. health delegates + deterministic + copy-on-read', () => {
  eq(A.health(), S.health());
  const h = A.health();
  assert.equal(h.healthy, true);
  assert.equal(h.modulesLoaded, 11);
  assert.deepEqual(A.health(), A.health()); // deterministic
  assert.notEqual(A.health(), A.health()); // fresh copy
  assert.notEqual(A.health().modulesAvailable, A.health().modulesAvailable);
});

test('E2-10. capabilities delegates + full list + copy-on-read', () => {
  eq(A.capabilities(), S.listCapabilities());
  const names = A.capabilities().map((c) => c.name);
  for (const cap of ['Numbering', 'Metadata', 'Policy', 'Assembly', 'Versioning', 'Approval', 'Review', 'Access', 'Storage', 'Compliance', 'Validation', 'Snapshots', 'Comparison', 'Normalization', 'Cloning', 'Immutability']) {
    assert.ok(names.includes(cap), `capability ${cap}`);
  }
  assert.ok(A.capabilities().every((c) => c.supported === true));
  assert.notEqual(A.capabilities(), A.capabilities());
  assert.notEqual(A.capabilities()[0], A.capabilities()[0]);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E2-11. export surface is exact (19 repository-style methods)', () => {
  assert.deepEqual(Object.keys(A).sort(), [
    'access', 'approve', 'archive', 'capabilities', 'clone', 'compliance', 'create', 'delete', 'get',
    'health', 'list', 'restore', 'review', 'search', 'snapshot', 'storage', 'update', 'validate', 'version',
  ]);
});

test('E2-12. every export is a function', () => {
  for (const k of Object.keys(A)) assert.equal(typeof A[k], 'function', `${k} is a function`);
});

test('E2-13. copy-on-read: adapter never mutates caller inputs', () => {
  const input = Object.freeze({ title: '  T  ', metadata: Object.freeze({ a: 1 }) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => A.create(input, { numbering: { template: 'D-{SEQUENCE}' } }), 'create');
  noThrow(() => A.get(input), 'get');
  noThrow(() => A.update(input, { x: 1 }), 'update');
  noThrow(() => A.archive(input), 'archive');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
});

test('E2-14. fresh object every call (no shared references)', () => {
  const input = { a: { b: 1 } };
  const r1 = A.get(input);
  const r2 = A.get(input);
  assert.notEqual(r1, r2);
  assert.notEqual(r1.a, r2.a);
  r1.a.b = 999; // mutating a returned object must not affect a later call
  assert.equal(A.get(input).a.b, 1);
});

test('E2-15. never throws: single-argument methods tolerate hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { a: {} }];
  for (const a of hostile) {
    for (const fn of ['get', 'list', 'search', 'restore', 'delete', 'clone', 'validate', 'snapshot', 'archive']) {
      noThrow(() => A[fn](a), `A.${fn}`);
    }
  }
});

test('E2-16. never throws: multi-argument + component methods tolerate hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { title: {} }, { template: 5 }];
  for (const a of hostile) {
    noThrow(() => A.create(a, a), 'A.create');
    noThrow(() => A.update(a, a, a), 'A.update');
    for (const fn of ['version', 'approve', 'review', 'access', 'storage', 'compliance']) {
      noThrow(() => A[fn](a, a), `A.${fn}`);
    }
  }
  noThrow(() => A.health(), 'A.health');
  noThrow(() => A.capabilities(), 'A.capabilities');
});

test('E2-17. deterministic: identical inputs produce identical adapter output', () => {
  assert.deepEqual(A.get({ a: 1 }), A.get({ a: 1 }));
  assert.deepEqual(A.create({ title: 'Z' }), A.create({ title: 'Z' }));
  assert.deepEqual(A.compliance({ framework: 'ISO9001' }), A.compliance({ framework: 'ISO9001' }));
  assert.equal(A.snapshot(builder.createDocument({ title: 'Z' })).digest, A.snapshot(builder.createDocument({ title: 'Z' })).digest);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E2-18. adapter imports ONLY the sibling document-service', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const src = fs.readFileSync(path.join(EDIR, 'repository-adapter.js'), 'utf8');
  assert.ok(!FORBIDDEN.test(src), 'no forbidden production import');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  assert.ok(/require\((['"])\.\/document-service\1\)/.test(requires[0]), `only ./document-service (found ${requires[0]})`);
});

test('E2-19. no forbidden persistence / SQL tokens in the adapter source', () => {
  const src = fs.readFileSync(path.join(EDIR, 'repository-adapter.js'), 'utf8');
  assert.ok(!/\brequire\(['"]sqlite3?['"]\)/.test(src), 'no sqlite require');
  assert.ok(!/\b(INSERT INTO|SELECT\s|UPDATE\s+tbl|DELETE FROM)\b/i.test(src), 'no SQL statements');
  assert.ok(!/database\/db|getDb\(|dbRun\(|dbAll\(/.test(src), 'no database access');
});

test('E2-20. adapter is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
