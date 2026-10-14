// WP-18 · E18 — Enterprise Document Engine Orchestrator Foundation tests.
// Verifies the façade delegates every public method to the correct underlying engine, returns
// fresh copies (copy-on-read), reports deterministic engine information / capabilities / health,
// never throws under hostile inputs, and delegates snapshot + validation + immutability to the
// existing implementations. Pure in-memory — no persistence, no HTTP, no database.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const E = require(path.join(EDIR, 'document-engine.js'));
// underlying engines, to prove delegation produces identical output
const builder = require(path.join(EDIR, 'document-builder.js'));
const assembly = require(path.join(EDIR, 'document-assembly.js'));
const versionManager = require(path.join(EDIR, 'document-version-manager.js'));
const metadataEngine = require(path.join(EDIR, 'metadata', 'metadata-engine.js'));
const policyEngine = require(path.join(EDIR, 'metadata', 'metadata-policy-engine.js'));
const NumberGenerator = require(path.join(EDIR, 'numbering', 'document-number-generator.js'));
const approvalManager = require(path.join(EDIR, 'document-approval-manager.js'));
const reviewManager = require(path.join(EDIR, 'document-review-manager.js'));
const accessManager = require(path.join(EDIR, 'document-access-manager.js'));
const storageManager = require(path.join(EDIR, 'document-storage-manager.js'));
const complianceManager = require(path.join(EDIR, 'document-compliance-manager.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const eq = (a, b) => assert.deepEqual(a, b);

// ---------------------------------------------------------------------------
// delegation: document façade
// ---------------------------------------------------------------------------

test('E18-1. createDocument / normalizeDocument / cloneDocument delegate to the builder', () => {
  const input = { title: '  Doc  ', metadata: { a: 1 } };
  eq(E.createDocument(input), builder.createDocument(input));
  eq(E.normalizeDocument(input), builder.normalizeDocument(input));
  eq(E.cloneDocument(input), builder.cloneDocument(input));
});

test('E18-2. freezeDocument delegates and produces a deep-frozen fresh copy', () => {
  const src = { title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] };
  const frozen = E.freezeDocument(src);
  eq(frozen, builder.freezeDocument(src));
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.relationships[0]));
  assert.equal(Object.isFrozen(src), false); // caller not frozen
});

test('E18-3. mergeDocument / compareDocument delegate to the builder', () => {
  eq(E.mergeDocument({ a: 1 }, { b: 2 }), builder.mergeDocuments({ a: 1 }, { b: 2 }));
  eq(E.mergeDocument({ t: [1] }, { t: [2] }, { arrays: 'union' }), builder.mergeDocuments({ t: [1] }, { t: [2] }, { arrays: 'union' }));
  eq(E.compareDocument({ a: 1, x: 1 }, { a: 2, y: 1 }), builder.compareDocuments({ a: 1, x: 1 }, { a: 2, y: 1 }));
});

test('E18-4. validateDocument delegates and always returns valid/errors/warnings', () => {
  const doc = builder.createDocument({ title: 'X' });
  const v = E.validateDocument(doc);
  eq(v, builder.validateStructure(doc));
  assert.ok('valid' in v && 'errors' in v && 'warnings' in v);
  assert.equal(E.validateDocument(5).valid, false); // hostile → structural error, never throws
});

test('E18-5. generateDocumentSnapshot delegates to the existing snapshot (no new hashing)', () => {
  const doc = builder.createDocument({ title: 'Snap', metadata: { a: 1 } });
  const s = E.generateDocumentSnapshot(doc);
  eq(s, builder.generateDocumentSnapshot(doc));
  assert.equal(s.schema, 'enterprise-document.v1');
  assert.equal(s.digest, builder.generateDocumentSnapshot(doc).digest); // identical digest algorithm
});

// ---------------------------------------------------------------------------
// delegation: assembly + components
// ---------------------------------------------------------------------------

test('E18-6. assembleDocument delegates to the assembly engine', () => {
  const input = { title: 'A', documentType: 'SOP', metadata: { Owner: 'x' } };
  const opts = { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } }, versionScheme: 'SEMANTIC' };
  eq(E.assembleDocument(input, opts), assembly.assembleDocument(input, opts));
});

test('E18-7. generateNumber delegates to a fresh number generator', () => {
  const cfg = { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } };
  const expected = new NumberGenerator(cfg).generate(cfg.context);
  eq(E.generateNumber(cfg), expected);
  assert.equal(E.generateNumber(cfg).number, 'SOP-2026-000001'); // deterministic (fresh generator)
  // invalid / hostile config resolves safely
  assert.equal(E.generateNumber({ template: '{BADTOKEN}-{SEQUENCE}' }).ok, false);
  assert.equal(E.generateNumber(5).ok, false); // non-object config → empty template → invalid
  assert.equal(E.generateNumber().ok, false); // no config
});

test('E18-8. buildMetadata / applyMetadataPolicy delegate to the metadata + policy engines', () => {
  eq(E.buildMetadata({ Title: '  hi  ' }, { normalize: true }), metadataEngine.createMetadata({ Title: '  hi  ' }, { normalize: true }));
  const meta = { Title: 'T', CreatedBy: 'sys', Weird: 1 };
  eq(E.applyMetadataPolicy(meta, 'CONTROLLED_DOCUMENT'), policyEngine.applyDefaults(meta, 'CONTROLLED_DOCUMENT'));
});

test('E18-9. createVersion / createApproval / createReview delegate', () => {
  eq(E.createVersion({ scheme: 'SEMANTIC', major: 1 }), versionManager.createVersion({ scheme: 'SEMANTIC', major: 1 }));
  eq(E.createApproval({ workflow: 'NONE' }), approvalManager.createApproval({ workflow: 'NONE' }));
  eq(E.createReview({ workflow: 'NONE' }), reviewManager.createReview({ workflow: 'NONE' }));
});

test('E18-10. createAccess / createStorage / createCompliance delegate', () => {
  eq(E.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }), accessManager.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }));
  eq(E.createStorage({ storageType: 'LOCAL_PRIVATE' }), storageManager.createStorage({ storageType: 'LOCAL_PRIVATE' }));
  eq(E.createCompliance({ framework: 'ISO9001' }), complianceManager.createCompliance({ framework: 'ISO9001' }));
});

// ---------------------------------------------------------------------------
// engine information / capabilities / health
// ---------------------------------------------------------------------------

test('E18-11. getEngineInformation: deterministic shape, copy-on-read', () => {
  const info = E.getEngineInformation();
  assert.deepEqual(Object.keys(info).sort(), ['engineVersion', 'futureReserved', 'schemaVersion', 'supportedFeatures', 'supportedModules']);
  assert.equal(info.engineVersion, '1.0.0-foundation');
  assert.equal(info.schemaVersion, 'enterprise-document.v1');
  assert.ok(info.supportedModules.includes('documentBuilder') && info.supportedModules.includes('complianceManager'));
  assert.ok(info.supportedFeatures.includes('snapshot') && info.supportedFeatures.includes('immutability'));
  assert.deepEqual(info.futureReserved, []);
  // deterministic + fresh copies
  assert.deepEqual(E.getEngineInformation(), E.getEngineInformation());
  assert.notEqual(E.getEngineInformation(), E.getEngineInformation());
  assert.notEqual(E.getEngineInformation().supportedModules, E.getEngineInformation().supportedModules);
});

test('E18-12. listCapabilities: full deterministic list, copy-on-read', () => {
  const caps = E.listCapabilities();
  const names = caps.map((c) => c.name);
  for (const cap of ['Numbering', 'Metadata', 'Policy', 'Assembly', 'Versioning', 'Approval', 'Review', 'Access', 'Storage', 'Compliance', 'Validation', 'Snapshots', 'Comparison', 'Normalization', 'Cloning', 'Immutability']) {
    assert.ok(names.includes(cap), `capability ${cap}`);
  }
  assert.ok(caps.every((c) => c.supported === true));
  assert.deepEqual(E.listCapabilities(), E.listCapabilities());
  assert.notEqual(E.listCapabilities(), E.listCapabilities());
  assert.notEqual(E.listCapabilities()[0], E.listCapabilities()[0]); // fresh objects
});

test('E18-13. health: deterministic, all modules loaded, copy-on-read', () => {
  const h = E.health();
  assert.deepEqual(Object.keys(h).sort(), ['futureReserved', 'healthy', 'modulesAvailable', 'modulesLoaded', 'warnings']);
  assert.equal(h.healthy, true);
  assert.equal(h.modulesLoaded, 11);
  assert.equal(h.modulesAvailable.length, 11);
  assert.deepEqual(h.warnings, []);
  assert.deepEqual(h.futureReserved, []);
  assert.deepEqual(E.health(), E.health());
  assert.notEqual(E.health(), E.health());
  assert.notEqual(E.health().modulesAvailable, E.health().modulesAvailable);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E18-14. export surface is exact (21 façade methods)', () => {
  assert.deepEqual(Object.keys(E).sort(), [
    'applyMetadataPolicy', 'assembleDocument', 'buildMetadata', 'cloneDocument', 'compareDocument',
    'createAccess', 'createApproval', 'createCompliance', 'createDocument', 'createReview', 'createStorage',
    'createVersion', 'freezeDocument', 'generateDocumentSnapshot', 'generateNumber', 'getEngineInformation',
    'health', 'listCapabilities', 'mergeDocument', 'normalizeDocument', 'validateDocument',
  ]);
});

test('E18-15. copy-on-read: façade never mutates caller inputs', () => {
  const input = Object.freeze({ title: '  T  ', metadata: Object.freeze({ a: 1 }) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => E.createDocument(input), 'createDocument');
  noThrow(() => E.assembleDocument(input, { numbering: { template: 'D-{SEQUENCE}' } }), 'assembleDocument');
  noThrow(() => E.normalizeDocument(input), 'normalizeDocument');
  noThrow(() => E.buildMetadata(input), 'buildMetadata');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap); // input unchanged
});

test('E18-16. never throws: every façade method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { title: {} }, { template: 5 }, { context: 5 }];
  for (const a of hostile) {
    for (const fn of ['createDocument', 'normalizeDocument', 'cloneDocument', 'freezeDocument', 'validateDocument', 'generateDocumentSnapshot', 'generateNumber', 'buildMetadata', 'createVersion', 'createApproval', 'createReview', 'createAccess', 'createStorage', 'createCompliance']) {
      noThrow(() => E[fn](a, a), `E.${fn}`);
    }
    noThrow(() => E.assembleDocument(a, a), 'E.assembleDocument');
    noThrow(() => E.applyMetadataPolicy(a, a, a), 'E.applyMetadataPolicy');
    noThrow(() => E.mergeDocument(a, a, a), 'E.mergeDocument');
    noThrow(() => E.compareDocument(a, a), 'E.compareDocument');
  }
  noThrow(() => E.getEngineInformation(), 'E.getEngineInformation');
  noThrow(() => E.listCapabilities(), 'E.listCapabilities');
  noThrow(() => E.health(), 'E.health');
});

test('E18-17. deterministic: identical inputs produce identical façade output', () => {
  assert.deepEqual(E.createDocument({ title: 'Z' }), E.createDocument({ title: 'Z' }));
  assert.deepEqual(E.generateNumber({ template: 'D-{SEQUENCE}' }), E.generateNumber({ template: 'D-{SEQUENCE}' }));
  assert.deepEqual(E.createCompliance({ framework: 'ISO9001' }), E.createCompliance({ framework: 'ISO9001' }));
  assert.equal(E.generateDocumentSnapshot(builder.createDocument({ title: 'Z' })).digest, E.generateDocumentSnapshot(builder.createDocument({ title: 'Z' })).digest);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E18-18. orchestrator imports only sibling document-engine modules', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const src = fs.readFileSync(path.join(EDIR, 'document-engine.js'), 'utf8');
  assert.ok(!FORBIDDEN.test(src), 'no forbidden production import');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.ok(requires.length > 0);
  for (const r of requires) {
    assert.ok(/require\((['"])\.\//.test(r), `only relative sibling imports (found ${r})`);
  }
});

test('E18-19. orchestrator is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});

test('E18-20. full round-trip composition through the façade (delegation end-to-end)', () => {
  // number → metadata → policy → assembly → version → approval/review/access/storage/compliance
  const number = E.generateNumber({ template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } });
  assert.equal(number.ok, true);
  const metadata = E.buildMetadata({ Title: 'Quality Manual', Owner: 'qa' }, { normalize: true });
  const conformed = E.applyMetadataPolicy(metadata, 'STANDARD_OPERATING_PROCEDURE');
  const doc = E.assembleDocument({ title: 'Quality Manual', documentType: 'SOP', metadata: conformed }, { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } } });
  assert.equal(doc.documentNumber, 'SOP-2026-000001');
  assert.equal(E.validateDocument(doc).valid !== undefined, true);
  const version = E.createVersion({ scheme: 'SEMANTIC', major: 1 });
  assert.equal(version.scheme, 'SEMANTIC');
  assert.equal(E.createApproval({ workflow: 'NONE' }).status, 'PENDING');
  assert.equal(E.createReview({ workflow: 'NONE' }).status, 'PENDING');
  assert.equal(E.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }).effectivePermissions.includes('read'), true);
  assert.equal(E.createStorage({ storageType: 'LOCAL_PRIVATE' }).provider, 'local');
  assert.equal(E.createCompliance({ framework: 'ISO9001' }).requiresDocumentControl, true);
  const snapshot = E.generateDocumentSnapshot(doc);
  assert.equal(snapshot.schema, 'enterprise-document.v1');
});
