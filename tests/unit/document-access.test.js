// WP-17 · D11 — Document access-control registry tests (immutable, 100% coverage).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const A = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-access.js'));

const EXPECTED = ['NONE', 'PUBLIC', 'AUTHENTICATED', 'EMPLOYEE', 'CONTRACTOR', 'OWNER', 'AUTHOR', 'EDITOR', 'REVIEWER', 'APPROVER', 'PUBLISHER', 'TRAINER', 'ASSESSOR', 'SUPERVISOR', 'MANAGER', 'HSEQ', 'HR', 'ADMIN', 'SYSTEM', 'AI_AGENT', 'CONTROLLED_DOCUMENT', 'READ_ONLY'];
const VALID_CATEGORIES = ['none', 'public', 'authenticated', 'employment', 'ownership', 'editing', 'review', 'approval', 'publishing', 'training', 'assessment', 'management', 'controlled', 'administration', 'system', 'ai'];
const CAN_KEYS = ['canRead', 'canCreate', 'canEdit', 'canDelete', 'canReview', 'canApprove', 'canPublish', 'canArchive', 'canRestore', 'canSupersede', 'canTranslate', 'canExport', 'canPrint', 'canDownload', 'canAssignTraining', 'canAssignAssessment', 'canManageRelationships', 'canManageMetadata'];
const REQ_KEYS = ['requiresAuthentication', 'requiresOwnership', 'requiresApprovalRole', 'requiresPublishedDocument', 'requiresActiveEmployment'];
const BOOL_KEYS = [...CAN_KEYS, ...REQ_KEYS];
const RESERVED_KEYS = ['workflowPolicy', 'ownershipPolicy', 'approvalPolicy', 'translationPolicy', 'relationshipPolicy', 'metadataPolicy', 'exportPolicy', 'trainingPolicy', 'assessmentPolicy', 'integrationPolicy'];

test('DA-1. registry has all expected modes with the full shape (all booleans)', () => {
  assert.deepEqual([...A.DOCUMENT_ACCESS_IDS].sort(), [...EXPECTED].sort());
  for (const id of A.DOCUMENT_ACCESS_IDS) {
    const a = A.DOCUMENT_ACCESS[id];
    assert.equal(a.id, id);
    assert.equal(typeof a.displayName, 'string');
    assert.equal(typeof a.description, 'string');
    assert.equal(typeof a.category, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof a[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof a.futureReserved, 'object');
  }
});

test('DA-2. unique ids, no duplicates', () => {
  assert.equal(A.DOCUMENT_ACCESS_IDS.length, new Set(A.DOCUMENT_ACCESS_IDS).size);
  assert.equal(A.DOCUMENT_ACCESS_IDS.length, EXPECTED.length);
});

test('DA-3. cross-validation: every category is one of VALID_CATEGORIES', () => {
  for (const id of A.DOCUMENT_ACCESS_IDS) {
    assert.ok(VALID_CATEGORIES.includes(A.DOCUMENT_ACCESS[id].category), `${id} category valid`);
  }
});

test('DA-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of A.DOCUMENT_ACCESS_IDS) {
    const fr = A.DOCUMENT_ACCESS[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DA-5. deep frozen / immutable (registry, ids, each mode, futureReserved)', () => {
  assert.ok(Object.isFrozen(A.DOCUMENT_ACCESS) && Object.isFrozen(A.DOCUMENT_ACCESS_IDS));
  for (const id of A.DOCUMENT_ACCESS_IDS) {
    assert.ok(Object.isFrozen(A.DOCUMENT_ACCESS[id]));
    assert.ok(Object.isFrozen(A.DOCUMENT_ACCESS[id].futureReserved));
  }
  try { A.DOCUMENT_ACCESS.HACK = {}; } catch { /* ok */ }
  try { A.DOCUMENT_ACCESS.OWNER.canDelete = false; } catch { /* ok */ }
  try { A.DOCUMENT_ACCESS.OWNER.futureReserved.workflowPolicy = 'x'; } catch { /* ok */ }
  assert.equal(A.DOCUMENT_ACCESS.HACK, undefined);
  assert.equal(A.DOCUMENT_ACCESS.OWNER.canDelete, true);
  assert.equal(A.DOCUMENT_ACCESS.OWNER.futureReserved.workflowPolicy, null);
});

test('DA-6. getDocumentAccess: known + unknown → deny-by-default safe default (per spec)', () => {
  assert.equal(A.getDocumentAccess('OWNER').id, 'OWNER');
  const d = A.getDocumentAccess('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Access');
  assert.equal(d.category, 'controlled');
  for (const k of CAN_KEYS) assert.equal(d[k], false, `UNKNOWN.${k} false (deny by default)`);
  assert.equal(d.requiresAuthentication, true);
  assert.equal(d.requiresOwnership, false);
  assert.equal(d.requiresApprovalRole, true);
  assert.equal(d.requiresPublishedDocument, false);
  assert.equal(d.requiresActiveEmployment, true);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(A.getDocumentAccess(bad).id, 'UNKNOWN');
});

test('DA-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = A.getDocumentAccess('OWNER');
  c.canRead = false; c.requiresOwnership = false; c.futureReserved.ownershipPolicy = 'y';
  const c2 = A.getDocumentAccess('OWNER');
  assert.equal(c2.canRead, true);
  assert.equal(c2.requiresOwnership, true);
  assert.equal(c2.futureReserved.ownershipPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DA-8. listDocumentAccess: fresh array + fresh objects; never exposes the registry', () => {
  const a = A.listDocumentAccess();
  const b = A.listDocumentAccess();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.workflowPolicy = 'z';
  assert.equal(A.listDocumentAccess().length, EXPECTED.length);
  assert.notEqual(A.getDocumentAccess('NONE').id, 'mutated');
  for (const x of b) assert.notEqual(x, A.DOCUMENT_ACCESS[x.id], 'listed object is a copy');
});

test('DA-9. isKnownDocumentAccess: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(A.isKnownDocumentAccess('OWNER'), true);
  assert.equal(A.isKnownDocumentAccess('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(A.isKnownDocumentAccess(bad), false);
});

test('DA-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => A.getDocumentAccess(bad));
    assert.doesNotThrow(() => A.isKnownDocumentAccess(bad));
  }
  assert.doesNotThrow(() => A.listDocumentAccess());
});

test('DA-11. registry integrity: every boolean varies; NONE deny-all; ADMIN allow-all; categories represented', () => {
  for (const k of BOOL_KEYS) {
    const vals = A.DOCUMENT_ACCESS_IDS.map((id) => A.DOCUMENT_ACCESS[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  for (const k of BOOL_KEYS) assert.equal(A.DOCUMENT_ACCESS.NONE[k], false, `NONE.${k} false`);
  for (const k of CAN_KEYS) assert.equal(A.DOCUMENT_ACCESS.ADMIN[k], true, `ADMIN.${k} true`);
  const cats = new Set(A.DOCUMENT_ACCESS_IDS.map((id) => A.DOCUMENT_ACCESS[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  assert.equal(A.DOCUMENT_ACCESS.OWNER.requiresOwnership, true);
  assert.equal(A.DOCUMENT_ACCESS.APPROVER.canApprove, true);
});

test('DA-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(A).sort(), ['DOCUMENT_ACCESS', 'DOCUMENT_ACCESS_IDS', 'getDocumentAccess', 'isKnownDocumentAccess', 'listDocumentAccess'].sort());
});
