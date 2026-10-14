// WP-17 · D7 — Document layout-template registry tests (immutable, cross-checked, 100% cov).
// NOTE: the D7 layout registry lives at lib/document/document-layout-templates.js (the D3
// document-type template registry keeps document-templates.js) — see the D7 report.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const T = require(path.join(ROOT, 'lib', 'document', 'document-layout-templates.js'));
const { DOCUMENT_TYPE_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-types.js'));
const { CLASSIFICATION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'classifications.js'));
const { DOCUMENT_APPROVAL_WORKFLOW_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-approval-workflows.js'));
const { REVIEW_FREQUENCY_IDS } = require(path.join(ROOT, 'lib', 'document', 'review-frequency.js'));
const { DOCUMENT_LIFECYCLE_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-lifecycle.js'));

const EXPECTED = ['BLANK', 'STANDARD', 'SOP', 'WORK_INSTRUCTION', 'TRAINING_MANUAL', 'POLICY', 'PROCEDURE', 'STANDARD_DOCUMENT', 'FORM', 'CHECKLIST', 'RISK_ASSESSMENT', 'JSA', 'SWMS', 'PRESENTATION', 'HANDBOOK', 'TOOLBOX_TALK', 'ASSESSMENT', 'REFERENCE', 'AI_GENERATED', 'EXTERNAL_STANDARD'];
const DEFAULT_FIELDS = ['defaultDocumentType', 'defaultClassification', 'defaultApprovalWorkflow', 'defaultReviewFrequency', 'defaultLifecycle'];
const FLAG_KEYS = ['supportsHeader', 'supportsFooter', 'supportsRevisionTable', 'supportsApprovals', 'supportsElectronicSignature', 'supportsReadAcknowledgement', 'supportsTableOfContents', 'supportsImages', 'supportsTables', 'supportsAttachments', 'supportsRiskMatrix', 'supportsAssessment', 'supportsTranslation', 'supportsAIContent', 'supportsVersionHistory', 'supportsMetadata', 'supportsReferences', 'supportsRelationships'];
const UNIVERSAL_TRUE = ['supportsHeader', 'supportsFooter', 'supportsMetadata'];
const RESERVED_KEYS = ['layoutEngine', 'brandingRule', 'renderRule', 'translationRule', 'numberingRule', 'approvalRule', 'metadataRule', 'workflowRule', 'aiRule', 'integrationRule'];

test('DLT-1. registry has all expected templates with the full shape', () => {
  assert.deepEqual([...T.DOCUMENT_TEMPLATE_IDS].sort(), [...EXPECTED].sort());
  for (const id of T.DOCUMENT_TEMPLATE_IDS) {
    const t = T.DOCUMENT_TEMPLATES[id];
    assert.equal(t.id, id);
    assert.equal(typeof t.displayName, 'string');
    assert.equal(typeof t.description, 'string');
    for (const f of DEFAULT_FIELDS) assert.equal(typeof t[f], 'string', `${id}.${f} string`);
    for (const k of FLAG_KEYS) assert.equal(typeof t[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof t.futureReserved, 'object');
  }
});

test('DLT-2. unique ids, no duplicates', () => {
  assert.equal(T.DOCUMENT_TEMPLATE_IDS.length, new Set(T.DOCUMENT_TEMPLATE_IDS).size);
  assert.equal(T.DOCUMENT_TEMPLATE_IDS.length, EXPECTED.length);
});

test('DLT-3. cross-validation: defaults exist in their reference registries', () => {
  for (const id of T.DOCUMENT_TEMPLATE_IDS) {
    const t = T.DOCUMENT_TEMPLATES[id];
    assert.ok(DOCUMENT_TYPE_IDS.includes(t.defaultDocumentType), `${id} defaultDocumentType known`);
    assert.ok(CLASSIFICATION_IDS.includes(t.defaultClassification), `${id} defaultClassification known`);
    assert.ok(DOCUMENT_APPROVAL_WORKFLOW_IDS.includes(t.defaultApprovalWorkflow), `${id} defaultApprovalWorkflow known`);
    assert.ok(REVIEW_FREQUENCY_IDS.includes(t.defaultReviewFrequency), `${id} defaultReviewFrequency known`);
    assert.ok(DOCUMENT_LIFECYCLE_IDS.includes(t.defaultLifecycle), `${id} defaultLifecycle known`);
  }
});

test('DLT-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of T.DOCUMENT_TEMPLATE_IDS) {
    const fr = T.DOCUMENT_TEMPLATES[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DLT-5. deep frozen / immutable (registry, ids, each template, futureReserved)', () => {
  assert.ok(Object.isFrozen(T.DOCUMENT_TEMPLATES) && Object.isFrozen(T.DOCUMENT_TEMPLATE_IDS));
  for (const id of T.DOCUMENT_TEMPLATE_IDS) {
    assert.ok(Object.isFrozen(T.DOCUMENT_TEMPLATES[id]));
    assert.ok(Object.isFrozen(T.DOCUMENT_TEMPLATES[id].futureReserved));
  }
  try { T.DOCUMENT_TEMPLATES.HACK = {}; } catch { /* ok */ }
  try { T.DOCUMENT_TEMPLATES.SOP.defaultClassification = 'X'; } catch { /* ok */ }
  try { T.DOCUMENT_TEMPLATES.SOP.futureReserved.aiRule = 'x'; } catch { /* ok */ }
  assert.equal(T.DOCUMENT_TEMPLATES.HACK, undefined);
  assert.equal(T.DOCUMENT_TEMPLATES.SOP.defaultClassification, 'SAFETY_CRITICAL');
  assert.equal(T.DOCUMENT_TEMPLATES.SOP.futureReserved.aiRule, null);
});

test('DLT-6. getDocumentTemplate: known + unknown → safe default (per spec, valid substitutes)', () => {
  assert.equal(T.getDocumentTemplate('SOP').id, 'SOP');
  const d = T.getDocumentTemplate('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Template');
  assert.equal(d.defaultDocumentType, 'REFERENCE');
  assert.equal(d.defaultClassification, 'INTERNAL');
  assert.equal(d.defaultApprovalWorkflow, 'MANAGER_APPROVAL');
  assert.equal(d.defaultReviewFrequency, 'YEARLY'); // spec ANNUALLY → valid YEARLY
  assert.equal(d.defaultLifecycle, 'publish');       // spec ACTIVE → valid publish
  // spec-mandated capability flags on the safe default
  assert.equal(d.supportsHeader, true); assert.equal(d.supportsFooter, true);
  assert.equal(d.supportsRevisionTable, true); assert.equal(d.supportsApprovals, true);
  assert.equal(d.supportsElectronicSignature, true); assert.equal(d.supportsReadAcknowledgement, false);
  assert.equal(d.supportsTableOfContents, false); assert.equal(d.supportsImages, true);
  assert.equal(d.supportsTables, true); assert.equal(d.supportsAttachments, false);
  assert.equal(d.supportsRiskMatrix, false); assert.equal(d.supportsAssessment, false);
  assert.equal(d.supportsTranslation, false); assert.equal(d.supportsAIContent, false);
  assert.equal(d.supportsVersionHistory, true); assert.equal(d.supportsMetadata, true);
  assert.equal(d.supportsReferences, false); assert.equal(d.supportsRelationships, false);
  // the safe default's substituted ids are themselves valid registry ids
  assert.ok(REVIEW_FREQUENCY_IDS.includes(d.defaultReviewFrequency));
  assert.ok(DOCUMENT_LIFECYCLE_IDS.includes(d.defaultLifecycle));
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(T.getDocumentTemplate(bad).id, 'UNKNOWN');
});

test('DLT-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = T.getDocumentTemplate('SOP');
  c.defaultDocumentType = 'HACK'; c.supportsHeader = false; c.futureReserved.layoutEngine = 'x';
  const c2 = T.getDocumentTemplate('SOP');
  assert.equal(c2.defaultDocumentType, 'SOP');
  assert.equal(c2.supportsHeader, true);
  assert.equal(c2.futureReserved.layoutEngine, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DLT-8. listDocumentTemplates: fresh array + fresh objects; never exposes the registry', () => {
  const a = T.listDocumentTemplates();
  const b = T.listDocumentTemplates();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.layoutEngine = 'x';
  assert.equal(T.listDocumentTemplates().length, EXPECTED.length);
  assert.notEqual(T.getDocumentTemplate('BLANK').id, 'mutated');
  for (const t of b) assert.notEqual(t, T.DOCUMENT_TEMPLATES[t.id], 'listed object is a copy');
});

test('DLT-9. isKnownDocumentTemplate: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(T.isKnownDocumentTemplate('SOP'), true);
  assert.equal(T.isKnownDocumentTemplate('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(T.isKnownDocumentTemplate(bad), false);
});

test('DLT-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => T.getDocumentTemplate(bad));
    assert.doesNotThrow(() => T.isKnownDocumentTemplate(bad));
  }
  assert.doesNotThrow(() => T.listDocumentTemplates());
});

test('DLT-11. registry integrity: capability flags meaningful; header/footer/metadata universal', () => {
  for (const k of FLAG_KEYS) {
    const vals = T.DOCUMENT_TEMPLATE_IDS.map((id) => T.DOCUMENT_TEMPLATES[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    if (!UNIVERSAL_TRUE.includes(k)) assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  for (const k of UNIVERSAL_TRUE) {
    assert.ok(T.DOCUMENT_TEMPLATE_IDS.every((id) => T.DOCUMENT_TEMPLATES[id][k] === true), `${k} true for every template`);
  }
  assert.equal(T.DOCUMENT_TEMPLATES.RISK_ASSESSMENT.supportsRiskMatrix, true);
  assert.equal(T.DOCUMENT_TEMPLATES.ASSESSMENT.supportsAssessment, true);
  assert.equal(T.DOCUMENT_TEMPLATES.AI_GENERATED.supportsAIContent, true);
  assert.equal(T.DOCUMENT_TEMPLATES.BLANK.supportsApprovals, false, 'blank is minimal');
});

test('DLT-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(T).sort(), ['DOCUMENT_TEMPLATES', 'DOCUMENT_TEMPLATE_IDS', 'getDocumentTemplate', 'isKnownDocumentTemplate', 'listDocumentTemplates'].sort());
});
