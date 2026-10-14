// WP-17 · D15 — Document validation-rule registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const V = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-validation.js'));

const EXPECTED = ['NONE', 'DOCUMENT_NUMBER_REQUIRED', 'TITLE_REQUIRED', 'DESCRIPTION_REQUIRED', 'OWNER_REQUIRED', 'AUTHOR_REQUIRED', 'REVIEWER_REQUIRED', 'APPROVER_REQUIRED', 'VERSION_REQUIRED', 'STATUS_REQUIRED', 'WORKFLOW_REQUIRED', 'CATEGORY_REQUIRED', 'TYPE_REQUIRED', 'CLASSIFICATION_REQUIRED', 'RETENTION_REQUIRED', 'ACCESS_REQUIRED', 'STORAGE_REQUIRED', 'PUBLISHING_REQUIRED', 'NOTIFICATION_REQUIRED', 'RELATIONSHIP_REQUIRED', 'METADATA_REQUIRED', 'ATTACHMENT_REQUIRED', 'READ_ACKNOWLEDGEMENT_REQUIRED', 'SIGNATURE_REQUIRED', 'TRANSLATION_REQUIRED', 'AI_REVIEW_REQUIRED', 'FILE_FORMAT_VALIDATION', 'FILE_SIZE_VALIDATION', 'CHECKSUM_VALIDATION', 'VIRUS_SCAN_VALIDATION', 'DUPLICATE_VALIDATION'];
const VALID_CATEGORIES = ['none', 'metadata', 'workflow', 'approval', 'publication', 'security', 'compliance', 'relationship', 'translation', 'ai', 'storage', 'content'];
const VALID_SEVERITIES = ['info', 'warning', 'error', 'critical'];
const BOOL_KEYS = ['blocking', 'requiresAudit', 'requiresApproval', 'requiresNotification'];
const RESERVED_KEYS = ['validationPolicy', 'ruleEnginePolicy', 'workflowPolicy', 'notificationPolicy', 'approvalPolicy', 'aiPolicy', 'integrationPolicy', 'overridePolicy', 'reportingPolicy', 'extensionPolicy'];

test('DV15-1. registry has all expected rules with the full shape', () => {
  assert.deepEqual([...V.DOCUMENT_VALIDATION_IDS].sort(), [...EXPECTED].sort());
  for (const id of V.DOCUMENT_VALIDATION_IDS) {
    const v = V.DOCUMENT_VALIDATION[id];
    assert.equal(v.id, id);
    assert.equal(typeof v.displayName, 'string');
    assert.equal(typeof v.description, 'string');
    assert.equal(typeof v.category, 'string');
    assert.equal(typeof v.severity, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof v[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof v.futureReserved, 'object');
  }
});

test('DV15-2. unique ids, no duplicates', () => {
  assert.equal(V.DOCUMENT_VALIDATION_IDS.length, new Set(V.DOCUMENT_VALIDATION_IDS).size);
  assert.equal(V.DOCUMENT_VALIDATION_IDS.length, EXPECTED.length);
});

test('DV15-3. cross-validation: every category and severity is valid', () => {
  for (const id of V.DOCUMENT_VALIDATION_IDS) {
    const v = V.DOCUMENT_VALIDATION[id];
    assert.ok(VALID_CATEGORIES.includes(v.category), `${id} category valid`);
    assert.ok(VALID_SEVERITIES.includes(v.severity), `${id} severity valid`);
  }
});

test('DV15-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of V.DOCUMENT_VALIDATION_IDS) {
    const fr = V.DOCUMENT_VALIDATION[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DV15-5. deep frozen / immutable (registry, ids, each rule, futureReserved)', () => {
  assert.ok(Object.isFrozen(V.DOCUMENT_VALIDATION) && Object.isFrozen(V.DOCUMENT_VALIDATION_IDS));
  for (const id of V.DOCUMENT_VALIDATION_IDS) {
    assert.ok(Object.isFrozen(V.DOCUMENT_VALIDATION[id]));
    assert.ok(Object.isFrozen(V.DOCUMENT_VALIDATION[id].futureReserved));
  }
  try { V.DOCUMENT_VALIDATION.HACK = {}; } catch { /* ok */ }
  try { V.DOCUMENT_VALIDATION.SIGNATURE_REQUIRED.blocking = false; } catch { /* ok */ }
  try { V.DOCUMENT_VALIDATION.SIGNATURE_REQUIRED.futureReserved.validationPolicy = 'x'; } catch { /* ok */ }
  assert.equal(V.DOCUMENT_VALIDATION.HACK, undefined);
  assert.equal(V.DOCUMENT_VALIDATION.SIGNATURE_REQUIRED.blocking, true);
  assert.equal(V.DOCUMENT_VALIDATION.SIGNATURE_REQUIRED.futureReserved.validationPolicy, null);
});

test('DV15-6. getDocumentValidation: known + unknown → most-critical safe default (exact spec)', () => {
  assert.equal(V.getDocumentValidation('TITLE_REQUIRED').id, 'TITLE_REQUIRED');
  const d = V.getDocumentValidation('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Validation');
  assert.equal(d.category, 'compliance');
  assert.equal(d.severity, 'critical');
  assert.equal(d.blocking, true);
  assert.equal(d.requiresAudit, true);
  assert.equal(d.requiresApproval, true);
  assert.equal(d.requiresNotification, false);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(V.getDocumentValidation(bad).id, 'UNKNOWN');
});

test('DV15-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = V.getDocumentValidation('CHECKSUM_VALIDATION');
  c.blocking = false; c.severity = 'info'; c.futureReserved.validationPolicy = 'y';
  const c2 = V.getDocumentValidation('CHECKSUM_VALIDATION');
  assert.equal(c2.blocking, true);
  assert.equal(c2.severity, 'critical');
  assert.equal(c2.futureReserved.validationPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DV15-8. listDocumentValidations: fresh array + fresh objects; never exposes the registry', () => {
  const a = V.listDocumentValidations();
  const b = V.listDocumentValidations();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.validationPolicy = 'z';
  assert.equal(V.listDocumentValidations().length, EXPECTED.length);
  assert.notEqual(V.getDocumentValidation('NONE').id, 'mutated');
  for (const v of b) assert.notEqual(v, V.DOCUMENT_VALIDATION[v.id], 'listed object is a copy');
});

test('DV15-9. isKnownDocumentValidation: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(V.isKnownDocumentValidation('TITLE_REQUIRED'), true);
  assert.equal(V.isKnownDocumentValidation('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(V.isKnownDocumentValidation(bad), false);
});

test('DV15-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => V.getDocumentValidation(bad));
    assert.doesNotThrow(() => V.isKnownDocumentValidation(bad));
  }
  assert.doesNotThrow(() => V.listDocumentValidations());
});

test('DV15-11. registry integrity: every boolean varies; all categories + severities represented', () => {
  for (const k of BOOL_KEYS) {
    const vals = V.DOCUMENT_VALIDATION_IDS.map((id) => V.DOCUMENT_VALIDATION[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(V.DOCUMENT_VALIDATION_IDS.map((id) => V.DOCUMENT_VALIDATION[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  const sevs = new Set(V.DOCUMENT_VALIDATION_IDS.map((id) => V.DOCUMENT_VALIDATION[id].severity));
  for (const s of VALID_SEVERITIES) assert.ok(sevs.has(s), `severity ${s} represented`);
  for (const k of BOOL_KEYS) assert.equal(V.DOCUMENT_VALIDATION.NONE[k], false, `NONE.${k} false`);
  assert.equal(V.DOCUMENT_VALIDATION.VIRUS_SCAN_VALIDATION.severity, 'critical');
  assert.equal(V.DOCUMENT_VALIDATION.SIGNATURE_REQUIRED.requiresApproval, true);
});

test('DV15-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(V).sort(), ['DOCUMENT_VALIDATION', 'DOCUMENT_VALIDATION_IDS', 'getDocumentValidation', 'isKnownDocumentValidation', 'listDocumentValidations'].sort());
});
