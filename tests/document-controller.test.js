// WP-19 · E4 — Enterprise Route Controller Foundation tests.
// Verifies the controller is a pure stateless façade that delegates every action to the API
// Adapter, returns fresh copies (copy-on-read), is deterministic, never throws under hostile
// inputs, exposes the exact 19-method surface, and is unwired (no Express/routes/HTTP).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const C = require(path.join(EDIR, 'controller.js'));
const api = require(path.join(EDIR, 'api-adapter.js'));
const builder = require(path.join(EDIR, 'document-builder.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const eq = (a, b) => assert.deepEqual(a, b);

// ---------------------------------------------------------------------------
// delegation: deep equality with the API adapter
// ---------------------------------------------------------------------------

test('E4-1. create delegates to api.createDocument', () => {
  const input = { title: 'A', documentType: 'SOP', metadata: { Owner: 'x' } };
  const opts = { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } } };
  eq(C.create(input, opts), api.createDocument(input, opts));
  assert.equal(C.create({ title: 'X' }, { numbering: { template: 'D-{SEQUENCE}' } }).documentNumber, 'D-000001');
});

test('E4-2. update delegates to api.updateDocument', () => {
  eq(C.update({ a: 1 }, { b: 2 }), api.updateDocument({ a: 1 }, { b: 2 }));
  eq(C.update({ t: [1] }, { t: [2] }, { arrays: 'union' }), api.updateDocument({ t: [1] }, { t: [2] }, { arrays: 'union' }));
});

test('E4-3. read-style get / list / search / restore / delete / clone delegate', () => {
  const doc = { a: { b: 1 }, arr: [1, 2] };
  eq(C.get(doc), api.getDocument(doc));
  eq(C.list(doc), api.listDocuments(doc));
  eq(C.search(doc), api.searchDocuments(doc));
  eq(C.restore(doc), api.restoreDocument(doc));
  eq(C.delete(doc), api.deleteDocument(doc));
  eq(C.clone(doc), api.cloneDocument(doc));
  assert.notEqual(C.get(doc), doc);
  assert.notEqual(C.get(doc).a, doc.a);
});

test('E4-4. validate delegates to api.validateDocument', () => {
  const doc = builder.createDocument({ title: 'X' });
  eq(C.validate(doc), api.validateDocument(doc));
  const v = C.validate(doc);
  assert.ok('valid' in v && 'errors' in v && 'warnings' in v);
  assert.equal(C.validate(5).valid, false);
});

test('E4-5. snapshot delegates to api.snapshotDocument', () => {
  const doc = builder.createDocument({ title: 'Snap', metadata: { a: 1 } });
  const s = C.snapshot(doc);
  eq(s, api.snapshotDocument(doc));
  assert.equal(s.schema, 'enterprise-document.v1');
  assert.equal(s.digest, api.snapshotDocument(doc).digest);
});

test('E4-6. archive delegates to api.archiveDocument (immutability) without freezing caller', () => {
  const src = { title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] };
  const frozen = C.archive(src);
  eq(frozen, api.archiveDocument(src));
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.relationships[0]));
  assert.equal(Object.isFrozen(src), false);
});

test('E4-7. version / approve / review delegate', () => {
  eq(C.version({ scheme: 'SEMANTIC', major: 1 }), api.versionDocument({ scheme: 'SEMANTIC', major: 1 }));
  eq(C.approve({ workflow: 'NONE' }), api.approveDocument({ workflow: 'NONE' }));
  eq(C.review({ workflow: 'NONE' }), api.reviewDocument({ workflow: 'NONE' }));
});

test('E4-8. access / storage / compliance delegate', () => {
  eq(C.access({ accessType: 'REVIEWER', permissions: ['read'] }), api.accessDocument({ accessType: 'REVIEWER', permissions: ['read'] }));
  eq(C.storage({ storageType: 'LOCAL_PRIVATE' }), api.storageDocument({ storageType: 'LOCAL_PRIVATE' }));
  eq(C.compliance({ framework: 'ISO9001' }), api.complianceDocument({ framework: 'ISO9001' }));
});

// ---------------------------------------------------------------------------
// information façade
// ---------------------------------------------------------------------------

test('E4-9. health delegates + deterministic + copy-on-read', () => {
  eq(C.health(), api.health());
  const h = C.health();
  assert.equal(h.healthy, true);
  assert.equal(h.modulesLoaded, 11);
  assert.deepEqual(C.health(), C.health());
  assert.notEqual(C.health(), C.health());
  assert.notEqual(C.health().modulesAvailable, C.health().modulesAvailable);
});

test('E4-10. capabilities delegates + full list + copy-on-read', () => {
  eq(C.capabilities(), api.capabilities());
  const names = C.capabilities().map((c) => c.name);
  for (const cap of ['Numbering', 'Metadata', 'Policy', 'Assembly', 'Versioning', 'Approval', 'Review', 'Access', 'Storage', 'Compliance', 'Validation', 'Snapshots', 'Comparison', 'Normalization', 'Cloning', 'Immutability']) {
    assert.ok(names.includes(cap), `capability ${cap}`);
  }
  assert.ok(C.capabilities().every((c) => c.supported === true));
  assert.notEqual(C.capabilities(), C.capabilities());
  assert.notEqual(C.capabilities()[0], C.capabilities()[0]);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E4-11. export surface is exact (19 controller actions)', () => {
  assert.deepEqual(Object.keys(C).sort(), [
    'access', 'approve', 'archive', 'capabilities', 'clone', 'compliance', 'create', 'delete', 'get',
    'health', 'list', 'restore', 'review', 'search', 'snapshot', 'storage', 'update', 'validate', 'version',
  ]);
});

test('E4-12. every export is a function', () => {
  for (const k of Object.keys(C)) assert.equal(typeof C[k], 'function', `${k} is a function`);
});

test('E4-13. copy-on-read: controller never mutates caller inputs', () => {
  const input = Object.freeze({ title: '  T  ', metadata: Object.freeze({ a: 1 }) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => C.create(input, { numbering: { template: 'D-{SEQUENCE}' } }), 'create');
  noThrow(() => C.get(input), 'get');
  noThrow(() => C.update(input, { x: 1 }), 'update');
  noThrow(() => C.archive(input), 'archive');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
});

test('E4-14. fresh object every call (no shared references)', () => {
  const input = { a: { b: 1 } };
  const r1 = C.get(input);
  const r2 = C.get(input);
  assert.notEqual(r1, r2);
  assert.notEqual(r1.a, r2.a);
  r1.a.b = 999;
  assert.equal(C.get(input).a.b, 1);
});

test('E4-15. never throws: single-argument methods tolerate hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { a: {} }];
  for (const a of hostile) {
    for (const fn of ['get', 'list', 'search', 'restore', 'delete', 'clone', 'validate', 'snapshot', 'archive']) {
      noThrow(() => C[fn](a), `C.${fn}`);
    }
  }
});

test('E4-16. never throws: multi-argument + component methods tolerate hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { title: {} }, { template: 5 }];
  for (const a of hostile) {
    noThrow(() => C.create(a, a), 'C.create');
    noThrow(() => C.update(a, a, a), 'C.update');
    for (const fn of ['version', 'approve', 'review', 'access', 'storage', 'compliance']) {
      noThrow(() => C[fn](a, a), `C.${fn}`);
    }
  }
  noThrow(() => C.health(), 'C.health');
  noThrow(() => C.capabilities(), 'C.capabilities');
});

test('E4-17. deterministic: identical inputs produce identical controller output', () => {
  assert.deepEqual(C.get({ a: 1 }), C.get({ a: 1 }));
  assert.deepEqual(C.create({ title: 'Z' }), C.create({ title: 'Z' }));
  assert.deepEqual(C.compliance({ framework: 'ISO9001' }), C.compliance({ framework: 'ISO9001' }));
  assert.equal(C.snapshot(builder.createDocument({ title: 'Z' })).digest, C.snapshot(builder.createDocument({ title: 'Z' })).digest);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E4-18. controller imports ONLY the sibling api-adapter', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const src = fs.readFileSync(path.join(EDIR, 'controller.js'), 'utf8');
  assert.ok(!FORBIDDEN.test(src), 'no forbidden production import');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  assert.ok(/require\((['"])\.\/api-adapter\1\)/.test(requires[0]), `only ./api-adapter (found ${requires[0]})`);
});

test('E4-19. no Express / route / HTTP / req-res tokens in the controller source', () => {
  const src = fs.readFileSync(path.join(EDIR, 'controller.js'), 'utf8');
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express require');
  assert.ok(!/\b(app\.(get|post|put|delete|use)|router\.|createServer|listen\(|res\.(json|send|status)|req\.(body|params|query))/.test(src), 'no HTTP/route/req-res wiring');
});

test('E4-20. controller is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
