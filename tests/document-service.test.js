// WP-19 · E1 — Enterprise Document Service Foundation tests.
// Verifies the service is a pure stateless façade that delegates every public method to the
// E18 orchestrator (document-engine.js), returns fresh copies (copy-on-read), is deterministic,
// never throws under hostile inputs, exposes the exact 21-method surface, and is unwired.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const S = require(path.join(EDIR, 'document-service.js'));
const E = require(path.join(EDIR, 'document-engine.js'));
const builder = require(path.join(EDIR, 'document-builder.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const eq = (a, b) => assert.deepEqual(a, b);

// ---------------------------------------------------------------------------
// delegation: deep equality with the underlying engine
// ---------------------------------------------------------------------------

test('E1-1. createDocument / normalizeDocument / cloneDocument delegate to the engine', () => {
  const input = { title: '  Doc  ', metadata: { a: 1 } };
  eq(S.createDocument(input), E.createDocument(input));
  eq(S.normalizeDocument(input), E.normalizeDocument(input));
  eq(S.cloneDocument(input), E.cloneDocument(input));
});

test('E1-2. assembleDocument delegates to the engine', () => {
  const input = { title: 'A', documentType: 'SOP', metadata: { Owner: 'x' } };
  const opts = { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } }, versionScheme: 'SEMANTIC' };
  eq(S.assembleDocument(input, opts), E.assembleDocument(input, opts));
});

test('E1-3. validateDocument delegates and returns valid/errors/warnings', () => {
  const doc = builder.createDocument({ title: 'X' });
  const v = S.validateDocument(doc);
  eq(v, E.validateDocument(doc));
  assert.ok('valid' in v && 'errors' in v && 'warnings' in v);
  assert.equal(S.validateDocument(5).valid, false);
});

test('E1-4. freezeDocument delegates: deep-frozen fresh copy, caller not frozen', () => {
  const src = { title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] };
  const frozen = S.freezeDocument(src);
  eq(frozen, E.freezeDocument(src));
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.relationships[0]));
  assert.equal(Object.isFrozen(src), false);
});

test('E1-5. mergeDocument / compareDocument delegate to the engine', () => {
  eq(S.mergeDocument({ a: 1 }, { b: 2 }), E.mergeDocument({ a: 1 }, { b: 2 }));
  eq(S.mergeDocument({ t: [1] }, { t: [2] }, { arrays: 'union' }), E.mergeDocument({ t: [1] }, { t: [2] }, { arrays: 'union' }));
  eq(S.compareDocument({ a: 1, x: 1 }, { a: 2, y: 1 }), E.compareDocument({ a: 1, x: 1 }, { a: 2, y: 1 }));
});

test('E1-6. generateDocumentSnapshot delegates to the engine snapshot', () => {
  const doc = builder.createDocument({ title: 'Snap', metadata: { a: 1 } });
  const s = S.generateDocumentSnapshot(doc);
  eq(s, E.generateDocumentSnapshot(doc));
  assert.equal(s.schema, 'enterprise-document.v1');
  assert.equal(s.digest, E.generateDocumentSnapshot(doc).digest);
});

test('E1-7. generateNumber / buildMetadata / applyMetadataPolicy delegate', () => {
  const cfg = { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } };
  eq(S.generateNumber(cfg), E.generateNumber(cfg));
  assert.equal(S.generateNumber(cfg).number, 'SOP-2026-000001');
  eq(S.buildMetadata({ Title: '  hi  ' }, { normalize: true }), E.buildMetadata({ Title: '  hi  ' }, { normalize: true }));
  const meta = { Title: 'T', CreatedBy: 'sys', Weird: 1 };
  eq(S.applyMetadataPolicy(meta, 'CONTROLLED_DOCUMENT'), E.applyMetadataPolicy(meta, 'CONTROLLED_DOCUMENT'));
});

test('E1-8. createVersion / createApproval / createReview delegate', () => {
  eq(S.createVersion({ scheme: 'SEMANTIC', major: 1 }), E.createVersion({ scheme: 'SEMANTIC', major: 1 }));
  eq(S.createApproval({ workflow: 'NONE' }), E.createApproval({ workflow: 'NONE' }));
  eq(S.createReview({ workflow: 'NONE' }), E.createReview({ workflow: 'NONE' }));
});

test('E1-9. createAccess / createStorage / createCompliance delegate', () => {
  eq(S.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }), E.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }));
  eq(S.createStorage({ storageType: 'LOCAL_PRIVATE' }), E.createStorage({ storageType: 'LOCAL_PRIVATE' }));
  eq(S.createCompliance({ framework: 'ISO9001' }), E.createCompliance({ framework: 'ISO9001' }));
});

// ---------------------------------------------------------------------------
// information façade
// ---------------------------------------------------------------------------

test('E1-10. getEngineInformation delegates + deterministic + copy-on-read', () => {
  eq(S.getEngineInformation(), E.getEngineInformation());
  const info = S.getEngineInformation();
  assert.deepEqual(Object.keys(info).sort(), ['engineVersion', 'futureReserved', 'schemaVersion', 'supportedFeatures', 'supportedModules']);
  assert.equal(info.engineVersion, '1.0.0-foundation');
  assert.deepEqual(S.getEngineInformation(), S.getEngineInformation()); // deterministic
  assert.notEqual(S.getEngineInformation(), S.getEngineInformation()); // fresh copy
  assert.notEqual(S.getEngineInformation().supportedModules, S.getEngineInformation().supportedModules);
});

test('E1-11. listCapabilities delegates + full list + copy-on-read', () => {
  eq(S.listCapabilities(), E.listCapabilities());
  const names = S.listCapabilities().map((c) => c.name);
  for (const cap of ['Numbering', 'Metadata', 'Policy', 'Assembly', 'Versioning', 'Approval', 'Review', 'Access', 'Storage', 'Compliance', 'Validation', 'Snapshots', 'Comparison', 'Normalization', 'Cloning', 'Immutability']) {
    assert.ok(names.includes(cap), `capability ${cap}`);
  }
  assert.ok(S.listCapabilities().every((c) => c.supported === true));
  assert.notEqual(S.listCapabilities(), S.listCapabilities());
  assert.notEqual(S.listCapabilities()[0], S.listCapabilities()[0]);
});

test('E1-12. health delegates + deterministic + copy-on-read', () => {
  eq(S.health(), E.health());
  const h = S.health();
  assert.deepEqual(Object.keys(h).sort(), ['futureReserved', 'healthy', 'modulesAvailable', 'modulesLoaded', 'warnings']);
  assert.equal(h.healthy, true);
  assert.equal(h.modulesLoaded, 11);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(S.health(), S.health());
  assert.notEqual(S.health(), S.health());
  assert.notEqual(S.health().modulesAvailable, S.health().modulesAvailable);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E1-13. export surface is exact (21 façade methods, matching the engine)', () => {
  const expected = ['applyMetadataPolicy', 'assembleDocument', 'buildMetadata', 'cloneDocument', 'compareDocument', 'createAccess', 'createApproval', 'createCompliance', 'createDocument', 'createReview', 'createStorage', 'createVersion', 'freezeDocument', 'generateDocumentSnapshot', 'generateNumber', 'getEngineInformation', 'health', 'listCapabilities', 'mergeDocument', 'normalizeDocument', 'validateDocument'];
  assert.deepEqual(Object.keys(S).sort(), expected);
  assert.deepEqual(Object.keys(S).sort(), Object.keys(E).sort()); // same surface as the engine
});

test('E1-14. every export is a function', () => {
  for (const k of Object.keys(S)) assert.equal(typeof S[k], 'function', `${k} is a function`);
});

test('E1-15. copy-on-read: façade never mutates caller inputs', () => {
  const input = Object.freeze({ title: '  T  ', metadata: Object.freeze({ a: 1 }) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => S.createDocument(input), 'createDocument');
  noThrow(() => S.assembleDocument(input, { numbering: { template: 'D-{SEQUENCE}' } }), 'assembleDocument');
  noThrow(() => S.normalizeDocument(input), 'normalizeDocument');
  noThrow(() => S.buildMetadata(input), 'buildMetadata');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
});

test('E1-16. fresh object returned each call (no shared references)', () => {
  const input = { title: 'Z', metadata: { a: 1 } };
  const d1 = S.createDocument(input);
  const d2 = S.createDocument(input);
  assert.notEqual(d1, d2);
  assert.notEqual(d1.metadata, d2.metadata);
  assert.deepEqual(d1, d2);
  d1.metadata.a = 999; // mutating a returned object must not affect a later call
  assert.equal(S.createDocument(input).metadata.a, 1);
});

test('E1-17. never throws: every façade method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { title: {} }, { template: 5 }, { context: 5 }];
  for (const a of hostile) {
    for (const fn of ['createDocument', 'normalizeDocument', 'cloneDocument', 'freezeDocument', 'validateDocument', 'generateDocumentSnapshot', 'generateNumber', 'buildMetadata', 'createVersion', 'createApproval', 'createReview', 'createAccess', 'createStorage', 'createCompliance']) {
      noThrow(() => S[fn](a, a), `S.${fn}`);
    }
    noThrow(() => S.assembleDocument(a, a), 'S.assembleDocument');
    noThrow(() => S.applyMetadataPolicy(a, a, a), 'S.applyMetadataPolicy');
    noThrow(() => S.mergeDocument(a, a, a), 'S.mergeDocument');
    noThrow(() => S.compareDocument(a, a), 'S.compareDocument');
  }
  noThrow(() => S.getEngineInformation(), 'S.getEngineInformation');
  noThrow(() => S.listCapabilities(), 'S.listCapabilities');
  noThrow(() => S.health(), 'S.health');
});

test('E1-18. deterministic: identical inputs produce identical façade output', () => {
  assert.deepEqual(S.createDocument({ title: 'Z' }), S.createDocument({ title: 'Z' }));
  assert.deepEqual(S.generateNumber({ template: 'D-{SEQUENCE}' }), S.generateNumber({ template: 'D-{SEQUENCE}' }));
  assert.deepEqual(S.createCompliance({ framework: 'ISO9001' }), S.createCompliance({ framework: 'ISO9001' }));
  assert.equal(S.generateDocumentSnapshot(builder.createDocument({ title: 'Z' })).digest, S.generateDocumentSnapshot(builder.createDocument({ title: 'Z' })).digest);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E1-19. service imports ONLY the sibling orchestrator', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const src = fs.readFileSync(path.join(EDIR, 'document-service.js'), 'utf8');
  assert.ok(!FORBIDDEN.test(src), 'no forbidden production import');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 1, 'exactly one require');
  assert.ok(/require\((['"])\.\/document-engine\1\)/.test(requires[0]), `only ./document-engine (found ${requires[0]})`);
});

test('E1-20. service is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
