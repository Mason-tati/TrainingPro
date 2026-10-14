// WP-17 · D8 — Document versioning registry tests (immutable, 100% coverage).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const V = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-versioning.js'));

const EXPECTED = ['NONE', 'SEMANTIC', 'MAJOR_MINOR', 'MAJOR_MINOR_PATCH', 'REVISION', 'CONTROLLED_DOCUMENT', 'ISO_DOCUMENT', 'TRAINING_CONTENT', 'AI_GENERATED', 'REFERENCE_ONLY', 'ARCHIVED'];
const FLAG_KEYS = ['majorSupported', 'minorSupported', 'patchSupported', 'revisionSupported', 'allowRollback', 'allowParallelVersions', 'allowDraftBranch', 'requireApprovalOnMajor', 'requireApprovalOnMinor', 'requireApprovalOnPatch', 'requireReviewOnRevision', 'trackChangeHistory', 'trackAuthorHistory', 'trackApprovalHistory', 'trackReadHistory', 'trackRelationshipHistory', 'supportsEffectiveDate', 'supportsExpiryDate', 'supportsObsoleteDate'];
const RESERVED_KEYS = ['mergePolicy', 'branchPolicy', 'conflictPolicy', 'retentionPolicy', 'approvalPolicy', 'aiPolicy', 'workflowPolicy', 'numberingPolicy', 'integrationPolicy', 'storagePolicy'];

test('DV-1. registry has all expected schemes with the full shape', () => {
  assert.deepEqual([...V.DOCUMENT_VERSIONING_IDS].sort(), [...EXPECTED].sort());
  for (const id of V.DOCUMENT_VERSIONING_IDS) {
    const s = V.DOCUMENT_VERSIONING[id];
    assert.equal(s.id, id);
    assert.equal(typeof s.displayName, 'string');
    assert.equal(typeof s.description, 'string');
    for (const k of FLAG_KEYS) assert.equal(typeof s[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof s.futureReserved, 'object');
  }
});

test('DV-2. unique ids, no duplicates', () => {
  assert.equal(V.DOCUMENT_VERSIONING_IDS.length, new Set(V.DOCUMENT_VERSIONING_IDS).size);
  assert.equal(V.DOCUMENT_VERSIONING_IDS.length, EXPECTED.length);
});

test('DV-3. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of V.DOCUMENT_VERSIONING_IDS) {
    const fr = V.DOCUMENT_VERSIONING[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DV-4. deep frozen / immutable (registry, ids, each scheme, futureReserved)', () => {
  assert.ok(Object.isFrozen(V.DOCUMENT_VERSIONING) && Object.isFrozen(V.DOCUMENT_VERSIONING_IDS));
  for (const id of V.DOCUMENT_VERSIONING_IDS) {
    assert.ok(Object.isFrozen(V.DOCUMENT_VERSIONING[id]));
    assert.ok(Object.isFrozen(V.DOCUMENT_VERSIONING[id].futureReserved));
  }
  try { V.DOCUMENT_VERSIONING.HACK = {}; } catch { /* ok */ }
  try { V.DOCUMENT_VERSIONING.SEMANTIC.majorSupported = false; } catch { /* ok */ }
  try { V.DOCUMENT_VERSIONING.SEMANTIC.futureReserved.mergePolicy = 'x'; } catch { /* ok */ }
  assert.equal(V.DOCUMENT_VERSIONING.HACK, undefined);
  assert.equal(V.DOCUMENT_VERSIONING.SEMANTIC.majorSupported, true);
  assert.equal(V.DOCUMENT_VERSIONING.SEMANTIC.futureReserved.mergePolicy, null);
});

test('DV-5. getDocumentVersioning: known + unknown → safe default (exact spec flags)', () => {
  assert.equal(V.getDocumentVersioning('SEMANTIC').id, 'SEMANTIC');
  const d = V.getDocumentVersioning('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Versioning');
  const EXPECT = {
    majorSupported: true, minorSupported: true, patchSupported: false, revisionSupported: true,
    allowRollback: false, allowParallelVersions: false, allowDraftBranch: false,
    requireApprovalOnMajor: true, requireApprovalOnMinor: true, requireApprovalOnPatch: true, requireReviewOnRevision: true,
    trackChangeHistory: true, trackAuthorHistory: true, trackApprovalHistory: true, trackReadHistory: false, trackRelationshipHistory: false,
    supportsEffectiveDate: true, supportsExpiryDate: false, supportsObsoleteDate: true,
  };
  for (const k of FLAG_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(V.getDocumentVersioning(bad).id, 'UNKNOWN');
});

test('DV-6. copy-on-read + mutation safety: registry never changes', () => {
  const c = V.getDocumentVersioning('SEMANTIC');
  c.majorSupported = false; c.futureReserved.mergePolicy = 'x';
  const c2 = V.getDocumentVersioning('SEMANTIC');
  assert.equal(c2.majorSupported, true);
  assert.equal(c2.futureReserved.mergePolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DV-7. listDocumentVersioning: fresh array + fresh objects; never exposes the registry', () => {
  const a = V.listDocumentVersioning();
  const b = V.listDocumentVersioning();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.mergePolicy = 'x';
  assert.equal(V.listDocumentVersioning().length, EXPECTED.length);
  assert.notEqual(V.getDocumentVersioning('NONE').id, 'mutated');
  for (const s of b) assert.notEqual(s, V.DOCUMENT_VERSIONING[s.id], 'listed object is a copy');
});

test('DV-8. isKnownDocumentVersioning: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(V.isKnownDocumentVersioning('SEMANTIC'), true);
  assert.equal(V.isKnownDocumentVersioning('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(V.isKnownDocumentVersioning(bad), false);
});

test('DV-9. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => V.getDocumentVersioning(bad));
    assert.doesNotThrow(() => V.isKnownDocumentVersioning(bad));
  }
  assert.doesNotThrow(() => V.listDocumentVersioning());
});

test('DV-10. registry integrity: every policy flag varies; scheme semantics', () => {
  for (const k of FLAG_KEYS) {
    const vals = V.DOCUMENT_VERSIONING_IDS.map((id) => V.DOCUMENT_VERSIONING[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  // NONE supports no versioning; SEMANTIC supports major/minor/patch; ISO is fully controlled
  for (const k of FLAG_KEYS) assert.equal(V.DOCUMENT_VERSIONING.NONE[k], false, `NONE.${k} false`);
  assert.equal(V.DOCUMENT_VERSIONING.SEMANTIC.patchSupported, true);
  assert.equal(V.DOCUMENT_VERSIONING.REVISION.revisionSupported, true);
  assert.equal(V.DOCUMENT_VERSIONING.ISO_DOCUMENT.requireApprovalOnPatch, true);
  assert.equal(V.DOCUMENT_VERSIONING.CONTROLLED_DOCUMENT.trackReadHistory, true);
});

test('DV-11. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(V).sort(), ['DOCUMENT_VERSIONING', 'DOCUMENT_VERSIONING_IDS', 'getDocumentVersioning', 'isKnownDocumentVersioning', 'listDocumentVersioning'].sort());
});
