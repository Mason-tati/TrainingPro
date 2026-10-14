// WP-18 · E8 — Enterprise Document Assembly Engine Foundation tests.
// Exhaustively exercises the pure builder (create/clone/normalize/freeze/compare/merge/
// validateStructure/snapshot) and the assembly engine (assemble* variants / validateAssembly
// / listAssemblyComponents). Covers hostile inputs, never-throw, determinism, immutability,
// fresh copies, futureReserved, export surface, and the unwired requirement. Pure in-memory —
// no DB, no network, no repositories, no services.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const B = require(path.join(EDIR, 'document-builder.js'));
const A = require(path.join(EDIR, 'document-assembly.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const DOC_FIELDS = ['id', 'documentNumber', 'title', 'description', 'metadata', 'policy', 'workflow', 'status', 'version', 'relationships', 'attachments', 'notifications', 'distribution', 'access', 'storage', 'search', 'compliance', 'validation', 'audit', 'customFields', 'futureReserved'];

// ---------------------------------------------------------------------------
// builder: create / structure
// ---------------------------------------------------------------------------

test('E8-1. builder.createDocument: full canonical structure, ordered, coercion of hostile fields', () => {
  const empty = B.createDocument();
  assert.deepEqual(Object.keys(empty), DOC_FIELDS); // stable canonical order, all 21 fields
  assert.equal(empty.id, null);
  assert.equal(empty.documentNumber, '');
  assert.deepEqual(empty.metadata, {});
  assert.deepEqual(empty.relationships, []);
  assert.deepEqual(empty.futureReserved, []);
  // coercion of wrong-typed inputs
  const c = B.createDocument({ id: { x: 1 }, documentNumber: {}, title: 5, description: null, metadata: [1], relationships: {}, status: [1] });
  assert.equal(c.id, null); // scalar object → null
  assert.equal(c.documentNumber, '[object Object]'); // string coercion of object
  assert.equal(c.title, '5'); // number → string
  assert.equal(c.description, ''); // null → ''
  assert.deepEqual(c.metadata, {}); // array → {}
  assert.deepEqual(c.relationships, []); // object → []
  assert.deepEqual(c.status, {}); // array → {}
  assert.equal(B.createDocument({ id: [1] }).id, null); // scalar array → null
  assert.equal(B.createDocument({ id: 'abc' }).id, 'abc'); // scalar primitive kept
});

test('E8-2. builder.validateStructure: valid / non-object / missing / wrong-kind / empty-title warning', () => {
  const good = B.createDocument({ title: 'X' });
  assert.equal(B.validateStructure(good).valid, true);
  const bad = B.validateStructure(5);
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].code, 'INVALID_STRUCTURE');
  const missing = B.validateStructure({ title: 'only' });
  assert.equal(missing.valid, false);
  assert.ok(missing.missingComponents.includes('metadata') && missing.missingComponents.includes('id'));
  const wrong = B.validateStructure(Object.assign(B.createDocument({ title: 'x' }), { metadata: [1], status: 'no', id: { a: 1 }, relationships: {} }));
  assert.ok(wrong.errors.some((e) => e.code === 'WRONG_KIND' && e.field === 'metadata'));
  assert.ok(wrong.errors.some((e) => e.code === 'WRONG_KIND' && e.field === 'status'));
  assert.ok(wrong.errors.some((e) => e.code === 'WRONG_KIND' && e.field === 'id'));
  const emptyTitle = B.validateStructure(B.createDocument({ title: '   ' }));
  assert.ok(emptyTitle.warnings.some((w) => w.code === 'EMPTY'));
});

// ---------------------------------------------------------------------------
// builder: clone / normalize / freeze
// ---------------------------------------------------------------------------

test('E8-3. builder.cloneDocument: deep copy, fresh nested, non-object coerced', () => {
  const src = B.createDocument({ title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] });
  const clone = B.cloneDocument(src);
  assert.notEqual(clone, src);
  assert.notEqual(clone.metadata, src.metadata);
  assert.notEqual(clone.relationships, src.relationships);
  assert.deepEqual(clone, src);
  assert.deepEqual(B.cloneDocument(5), {});
});

test('E8-4. builder.normalizeDocument: stable order, trim strings, sort keys, dedupe + sort arrays, extras after', () => {
  const doc = {
    zExtra: '  x  ', title: '  Hi  ', access: ['read', '', 'admin', 'read'],
    customFields: { b: '  y  ', a: 1 }, relationships: [{ t: 2 }, { t: 1 }, { t: 1 }],
    attachments: [null, { f: 1 }],
  };
  const n = B.normalizeDocument(doc);
  const keys = Object.keys(n);
  assert.equal(keys[keys.length - 1], 'zExtra'); // unknown extras placed last
  assert.equal(n.title, 'Hi'); // trimmed
  assert.deepEqual(n.access, ['admin', 'read']); // trimmed, '' dropped, deduped, sorted (scalar canon)
  assert.deepEqual(n.customFields, { a: 1, b: 'y' }); // keys sorted, string trimmed
  assert.deepEqual(n.relationships, [{ t: 1 }, { t: 2 }]); // object array deduped + sorted (object canon)
  assert.deepEqual(n.attachments, [null, { f: 1 }]); // null retained (null canon), object canon
  assert.equal(B.normalizeDocument(5) && typeof B.normalizeDocument(5), 'object');
});

test('E8-5. builder.freezeDocument: deep frozen; caller never frozen', () => {
  const src = { title: 'T', metadata: { a: 1 }, relationships: [{ r: 1 }] };
  const frozen = B.freezeDocument(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.relationships) && Object.isFrozen(frozen.relationships[0]));
  assert.equal(Object.isFrozen(src), false);
});

// ---------------------------------------------------------------------------
// builder: compare / merge
// ---------------------------------------------------------------------------

test('E8-6. builder.compareDocuments: added / removed / modified / unchanged + deepEqual matrix', () => {
  const a = { title: 'a', id: 1, metadata: { x: 1 }, relationships: [1], same: 't' };
  const b = { title: 'b', metadata: { x: 2 }, relationships: [1], same: 't', extra: 9 };
  const d = B.compareDocuments(a, b);
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['id']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'title']);
  assert.deepEqual(d.unchanged.sort(), ['relationships', 'same']);
  assert.deepEqual(B.compareDocuments(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => B.compareDocuments({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(B.compareDocuments({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E8-7. builder.mergeDocuments: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(B.mergeDocuments({ a: 1 }, { b: 2 }), { a: 1, b: 2 }); // new key
  assert.deepEqual(B.mergeDocuments({ a: 1 }, { a: 2 }), { a: 2 }); // scalar overwrite
  assert.deepEqual(B.mergeDocuments({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(B.mergeDocuments({ t: [1] }, { t: [2] }).t, [2]); // array replace overwrite
  assert.deepEqual(B.mergeDocuments({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]); // array replace keep
  assert.deepEqual(B.mergeDocuments({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(B.mergeDocuments({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(B.mergeDocuments({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(B.mergeDocuments({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 }); // object replace overwrite
  assert.deepEqual(B.mergeDocuments({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(B.mergeDocuments(5, { a: 1 }), { a: 1 }); // non-object base
});

// ---------------------------------------------------------------------------
// builder: snapshot
// ---------------------------------------------------------------------------

test('E8-8. builder.generateDocumentSnapshot: deterministic, immutable, digested', () => {
  const doc = B.createDocument({ title: 'Snap', metadata: { a: 1 } });
  const s1 = B.generateDocumentSnapshot(doc);
  const s2 = B.generateDocumentSnapshot(doc);
  assert.equal(s1.schema, 'enterprise-document.v1');
  assert.equal(typeof s1.digest, 'string');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.fieldCount, Object.keys(s1.document).length);
  assert.equal(s1.digest, s2.digest); // deterministic
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.document));
  // a change in content changes the digest
  assert.notEqual(s1.digest, B.generateDocumentSnapshot(B.createDocument({ title: 'Different' })).digest);
});

// ---------------------------------------------------------------------------
// assembly: variants
// ---------------------------------------------------------------------------

test('E8-9. assembleDocument: composes number generator, metadata, policy, registries; no mutation', () => {
  const input = { title: '  Hello  ', documentType: 'SOP', metadata: { Owner: 'alice' }, status: 'DRAFT' };
  const opts = { numbering: { template: 'SOP-{YEAR}-{SEQUENCE}', context: { year: 2026 } }, versionScheme: 'SEMANTIC' };
  const d = A.assembleDocument(input, opts);
  assert.equal(Object.keys(d).length, 21);
  assert.equal(d.documentNumber, 'SOP-2026-000001');
  assert.equal(d.status.id, 'DRAFT'); // resolved status registry object
  assert.equal(d.version.scheme, 'SEMANTIC'); // resolved versioning registry
  assert.equal(d.metadata.DocumentType, 'SOP');
  assert.equal(d.metadata.DocumentTypeName, 'Standard Operating Procedure'); // enriched from types registry
  assert.deepEqual(d.audit, [{ event: 'assembled', kind: 'document' }]);
  assert.deepEqual(d.futureReserved, []);
  assert.deepEqual(input, { title: '  Hello  ', documentType: 'SOP', metadata: { Owner: 'alice' }, status: 'DRAFT' }); // not mutated
  // documentNumber falls through to input when no numbering template; invalid template → ''
  assert.equal(A.assembleDocument({ documentNumber: 'MANUAL-1' }).documentNumber, 'MANUAL-1');
  assert.equal(A.assembleDocument({}, { numbering: { template: '{BADTOKEN}-{SEQUENCE}' } }).documentNumber, ''); // generator fails safely
  // documentType via metadata; version fields coerced
  const viaMeta = A.assembleDocument({ metadata: { DocumentType: 'FORM' }, version: { major: 'x', minor: 2, revision: 'B', label: 'rc1' } });
  assert.equal(viaMeta.metadata.DocumentType, 'FORM');
  assert.equal(viaMeta.version.major, 0); // non-integer → default 0
  assert.equal(viaMeta.version.minor, 2);
  assert.equal(viaMeta.version.revision, 'B');
  assert.equal(viaMeta.version.label, 'rc1');
});

test('E8-10. assembleDocument: normalize + freeze options', () => {
  const norm = A.assembleDocument({ title: '  T  ', access: ['b', 'a', 'a'] }, { normalize: true });
  assert.equal(norm.title, 'T');
  assert.deepEqual(norm.access, ['a', 'b']);
  const frozen = A.assembleDocument({ title: 'T' }, { freeze: true });
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata));
});

test('E8-11. assembleDraft / assembleTemplate: preset status + policy', () => {
  const draft = A.assembleDraft({ title: 'D' });
  assert.equal(draft.status.id, 'DRAFT');
  assert.equal(draft.policy.id, 'NONE');
  assert.equal(draft.audit[0].kind, 'draft');
  const tpl = A.assembleTemplate({ title: 'T' });
  assert.equal(tpl.policy.id, 'TEMPLATE');
  assert.equal(tpl.audit[0].kind, 'template');
});

test('E8-12. assembleRevision: version bump (major / patch / default minor) + revised audit', () => {
  const major = A.assembleRevision({ title: 'R', version: { major: 1, minor: 3, patch: 2 } }, { bump: 'major' });
  assert.deepEqual([major.version.major, major.version.minor, major.version.patch], [2, 0, 0]);
  const patch = A.assembleRevision({ title: 'R', version: { patch: 4 } }, { bump: 'patch' });
  assert.equal(patch.version.patch, 5);
  const minor = A.assembleRevision({ title: 'R', version: { minor: 1 } }); // default bump = minor
  assert.deepEqual([minor.version.minor, minor.version.patch], [2, 0]);
  assert.deepEqual(minor.audit.map((a) => a.event), ['assembled', 'revised']);
});

test('E8-13. assembleTranslation / assembleArchive', () => {
  const tr = A.assembleTranslation({ title: 'X', language: 'fr', sourceId: 'DOC-1' });
  assert.equal(tr.policy.id, 'TRANSLATION');
  assert.equal(tr.metadata.Language, 'fr');
  assert.deepEqual(tr.relationships, [{ type: 'translationOf', target: 'DOC-1' }]);
  // language absent (untouched) + sourceId absent (null target)
  const tr2 = A.assembleTranslation({ title: 'Y' });
  assert.equal('Language' in tr2.metadata, false);
  assert.equal(tr2.relationships[0].target, null);
  const ar = A.assembleArchive({ title: 'A' });
  assert.equal(ar.status.id, 'ARCHIVED');
  assert.equal(ar.policy.id, 'ARCHIVE');
  assert.deepEqual(ar.audit.map((a) => a.event), ['assembled', 'archived']);
});

// ---------------------------------------------------------------------------
// assembly: validation / components
// ---------------------------------------------------------------------------

test('E8-14. validateAssembly: shape, completeness, missing critical components, non-object', () => {
  const full = A.assembleDocument({ title: 'X', metadata: { Owner: 'o' }, status: 'DRAFT' }, { numbering: { template: 'D-{SEQUENCE}' } });
  const okv = A.validateAssembly(full);
  assert.deepEqual(Object.keys(okv).sort(), ['completeness', 'errors', 'missingComponents', 'valid', 'warnings']);
  assert.equal(okv.valid, true);
  assert.ok(okv.completeness > 0 && okv.completeness <= 1);
  // empty doc: title/documentNumber empty → missing critical components (present-but-empty path)
  const emptyAssembled = A.assembleDocument({});
  const ev = A.validateAssembly(emptyAssembled);
  assert.equal(ev.valid, false);
  assert.ok(ev.missingComponents.includes('title') && ev.missingComponents.includes('documentNumber'));
  // structurally-missing fields (raw object) + non-object
  const structMissing = A.validateAssembly({});
  assert.ok(structMissing.missingComponents.includes('metadata'));
  const nonObj = A.validateAssembly(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.completeness, 0);
});

test('E8-15. listAssemblyComponents: deterministic, copy-on-read, expected components', () => {
  const c1 = A.listAssemblyComponents();
  const c2 = A.listAssemblyComponents();
  assert.notEqual(c1, c2); // fresh array
  assert.notEqual(c1[0], c2[0]); // fresh objects
  assert.deepEqual(c1, c2); // deterministic
  assert.deepEqual(c1.map((x) => x.name), ['documentBuilder', 'numberGenerator', 'metadataEngine', 'metadataPolicyEngine', 'documentTypes', 'documentStatuses', 'documentWorkflows', 'documentVersioning']);
  c1[0].name = 'HACK';
  assert.equal(A.listAssemblyComponents()[0].name, 'documentBuilder'); // mutation does not leak
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E8-16. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(B).sort(), ['cloneDocument', 'compareDocuments', 'createDocument', 'freezeDocument', 'generateDocumentSnapshot', 'mergeDocuments', 'normalizeDocument', 'validateStructure']);
  assert.deepEqual(Object.keys(A).sort(), ['assembleArchive', 'assembleDocument', 'assembleDraft', 'assembleRevision', 'assembleTemplate', 'assembleTranslation', 'listAssemblyComponents', 'validateAssembly']);
});

test('E8-17. never throws: every builder + assembly method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { title: {} }, { metadata: 5 }, { version: { major: 'x' } }];
  for (const a of hostile) {
    noThrow(() => B.createDocument(a), 'createDocument');
    noThrow(() => B.cloneDocument(a), 'cloneDocument');
    noThrow(() => B.normalizeDocument(a), 'normalizeDocument');
    noThrow(() => B.freezeDocument(a), 'freezeDocument');
    noThrow(() => B.compareDocuments(a, a), 'compareDocuments');
    noThrow(() => B.mergeDocuments(a, a, a), 'mergeDocuments');
    noThrow(() => B.validateStructure(a), 'validateStructure');
    noThrow(() => B.generateDocumentSnapshot(a), 'generateDocumentSnapshot');
    noThrow(() => A.assembleDocument(a, a), 'assembleDocument');
    noThrow(() => A.assembleDraft(a, a), 'assembleDraft');
    noThrow(() => A.assembleTemplate(a, a), 'assembleTemplate');
    noThrow(() => A.assembleRevision(a, a), 'assembleRevision');
    noThrow(() => A.assembleTranslation(a, a), 'assembleTranslation');
    noThrow(() => A.assembleArchive(a, a), 'assembleArchive');
    noThrow(() => A.validateAssembly(a), 'validateAssembly');
  }
});

test('E8-18. deterministic + immutable outputs; frozen input not mutated', () => {
  const input = Object.freeze({ title: 'Z', metadata: Object.freeze({ a: 1 }) });
  const snapshot = JSON.parse(JSON.stringify(input));
  noThrow(() => A.assembleDocument(input, { numbering: { template: 'Z-{SEQUENCE}' } }), 'assemble frozen input');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot); // input unchanged
  assert.deepEqual(A.assembleDocument({ title: 'Z' }), A.assembleDocument({ title: 'Z' })); // deterministic
  assert.equal(
    B.generateDocumentSnapshot(A.assembleDocument({ title: 'Z' })).digest,
    B.generateDocumentSnapshot(A.assembleDocument({ title: 'Z' })).digest,
  );
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E8-19. assembly modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-builder.js', 'document-assembly.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E8-20. assembly engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
