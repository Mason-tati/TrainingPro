// WP-17 · D3 — Document-template registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const T = require(path.join(ROOT, 'lib', 'document', 'document-templates.js'));
const { DOCUMENT_TYPE_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-types.js'));
const { DOCUMENT_STATUS_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-status.js'));
const { REVIEW_FREQUENCY_IDS } = require(path.join(ROOT, 'lib', 'document', 'review-frequency.js'));
const { APPROVAL_LEVEL_IDS } = require(path.join(ROOT, 'lib', 'document', 'approval-levels.js'));
const { getDocumentGovernance } = require(path.join(ROOT, 'lib', 'document', 'document-governance.js'));
const { CLASSIFICATION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'classifications.js'));
const { RETENTION_IDS } = require(path.join(ROOT, 'lib', 'governance', 'retention.js'));
const { ENTITY_IDS } = require(path.join(ROOT, 'lib', 'governance', 'entities.js'));

const EXPECTED = ['SOP', 'WORK_INSTRUCTION', 'TRAINING_MANUAL', 'POLICY', 'PROCEDURE', 'STANDARD', 'FORM', 'CHECKLIST', 'RISK_ASSESSMENT', 'JSA', 'SWMS', 'PRESENTATION', 'HANDBOOK', 'TOOLBOX_TALK', 'ASSESSMENT', 'REFERENCE', 'AI_CONTENT', 'IMAGE', 'VIDEO', 'EXTERNAL_STANDARD'];
const DEFAULT_FIELDS = ['documentType', 'defaultWorkflow', 'defaultStatus', 'defaultReviewFrequency', 'defaultApprovalLevel', 'defaultClassification', 'defaultRetention'];
const CAP_FLAGS = ['requiresVersioning', 'requiresApproval', 'requiresReview', 'requiresRiskAssessment', 'supportsTranslation', 'supportsReadAcknowledgement', 'supportsElectronicSignature', 'supportsAI', 'supportsAttachments', 'supportsImages', 'supportsVideo', 'supportsPowerPoint', 'supportsAssessment', 'supportsRevisionHistory', 'supportsArchiving', 'supportsPublishing', 'supportsMetadata', 'supportsNumbering', 'supportsLifecycle', 'supportsAudit'];
const RESERVED_KEYS = ['builder', 'workflow', 'approvalFlow', 'numberingScheme', 'retentionPolicy', 'reviewPolicy', 'distributionPolicy', 'aiPrompt', 'translationProfile', 'brandingProfile', 'exportProfile', 'permissionsProfile', 'customFields', 'integrationHooks'];

test('DT3-1. registry has all expected templates with the full shape', () => {
  assert.deepEqual([...T.TEMPLATE_IDS].sort(), [...EXPECTED].sort());
  for (const id of T.TEMPLATE_IDS) {
    const t = T.TEMPLATES[id];
    assert.equal(t.id, id);
    assert.equal(typeof t.displayName, 'string');
    assert.equal(typeof t.description, 'string');
    for (const f of DEFAULT_FIELDS) assert.equal(typeof t[f], 'string', `${id}.${f} string`);
    for (const c of CAP_FLAGS) assert.equal(typeof t[c], 'boolean', `${id}.${c} boolean`);
  }
});

test('DT3-2. unique ids, no duplicates', () => {
  assert.equal(T.TEMPLATE_IDS.length, new Set(T.TEMPLATE_IDS).size);
  assert.equal(T.TEMPLATE_IDS.length, EXPECTED.length);
});

test('DT3-3. deep frozen / immutable (registry, ids, each template, futureReserved)', () => {
  assert.ok(Object.isFrozen(T.TEMPLATES) && Object.isFrozen(T.TEMPLATE_IDS));
  for (const id of T.TEMPLATE_IDS) {
    assert.ok(Object.isFrozen(T.TEMPLATES[id]));
    assert.ok(Object.isFrozen(T.TEMPLATES[id].futureReserved));
  }
  try { T.TEMPLATES.HACK = {}; } catch { /* ok */ }
  try { T.TEMPLATES.SOP.defaultClassification = 'X'; } catch { /* ok */ }
  try { T.TEMPLATES.SOP.futureReserved.builder = 'x'; } catch { /* ok */ }
  assert.equal(T.TEMPLATES.HACK, undefined);
  assert.equal(T.TEMPLATES.SOP.defaultClassification, 'SAFETY_CRITICAL');
  assert.equal(T.TEMPLATES.SOP.futureReserved.builder, null);
});

test('DT3-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of T.TEMPLATE_IDS) {
    const fr = T.TEMPLATES[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DT3-5. getTemplate: known lookup + unknown → most-restrictive UNKNOWN default', () => {
  assert.equal(T.getTemplate('SOP').id, 'SOP');
  const d = T.getTemplate('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Template');
  assert.equal(d.requiresApproval, true);
  assert.equal(d.requiresVersioning, true);
  assert.equal(d.requiresReview, true);
  assert.equal(d.defaultClassification, 'CONFIDENTIAL');
  assert.equal(d.defaultRetention, 'standard');
  // everything else disabled
  for (const c of CAP_FLAGS) {
    if (['requiresApproval', 'requiresVersioning', 'requiresReview'].includes(c)) continue;
    assert.equal(d[c], false, `UNKNOWN.${c} disabled`);
  }
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(T.getTemplate(bad).id, 'UNKNOWN');
});

test('DT3-6. copy-on-read + mutation safety: registry never changes', () => {
  const c = T.getTemplate('SOP');
  c.defaultClassification = 'HACK'; c.requiresApproval = false; c.futureReserved.builder = 'x';
  const c2 = T.getTemplate('SOP');
  assert.equal(c2.defaultClassification, 'SAFETY_CRITICAL');
  assert.equal(c2.requiresApproval, true);
  assert.equal(c2.futureReserved.builder, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DT3-7. listTemplates: fresh array + fresh objects; never exposes the registry', () => {
  const a = T.listTemplates();
  const b = T.listTemplates();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.builder = 'x';
  assert.equal(T.listTemplates().length, EXPECTED.length);
  assert.notEqual(T.getTemplate('SOP').id, 'mutated');
  assert.equal(T.getTemplate('SOP').futureReserved.builder, null);
  for (const t of b) assert.notEqual(t, T.TEMPLATES[t.id], 'listed object is a copy, not the registry entry');
});

test('DT3-8. isKnownTemplate: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(T.isKnownTemplate('SOP'), true);
  assert.equal(T.isKnownTemplate('UNKNOWN'), false, 'UNKNOWN safe default is not a known template');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(T.isKnownTemplate(bad), false);
});

test('DT3-9. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => T.getTemplate(bad));
    assert.doesNotThrow(() => T.isKnownTemplate(bad));
  }
  assert.doesNotThrow(() => T.listTemplates());
});

test('DT3-10. cross-check: every template references known type/status/frequency/approval/classification/retention', () => {
  for (const id of T.TEMPLATE_IDS) {
    const t = T.TEMPLATES[id];
    assert.ok(DOCUMENT_TYPE_IDS.includes(t.documentType), `${id} documentType known`);
    assert.ok(DOCUMENT_STATUS_IDS.includes(t.defaultStatus), `${id} defaultStatus known`);
    assert.ok(REVIEW_FREQUENCY_IDS.includes(t.defaultReviewFrequency), `${id} reviewFrequency known`);
    assert.ok(APPROVAL_LEVEL_IDS.includes(t.defaultApprovalLevel), `${id} approvalLevel known`);
    assert.ok(CLASSIFICATION_IDS.includes(t.defaultClassification), `${id} classification known`);
    assert.ok(RETENTION_IDS.includes(t.defaultRetention), `${id} retention known`);
  }
});

test('DT3-11. cross-check: every template documentType resolves to a known governance mapping', () => {
  for (const id of T.TEMPLATE_IDS) {
    const t = T.TEMPLATES[id];
    const gov = getDocumentGovernance(t.documentType);
    assert.ok(ENTITY_IDS.includes(gov.entity), `${id} → governance entity known`);
    assert.ok(CLASSIFICATION_IDS.includes(gov.classification), `${id} → governance classification known`);
    assert.equal(gov.type, t.documentType, `${id} governance resolves same type`);
  }
});

test('DT3-12. registry integrity: capability flags are meaningful (used + not universal)', () => {
  for (const c of CAP_FLAGS) {
    const vals = T.TEMPLATE_IDS.map((id) => T.TEMPLATES[id][c]);
    assert.ok(vals.includes(true), `${c} true for at least one template`);
  }
  // spot-check known semantics
  assert.equal(T.TEMPLATES.SOP.requiresRiskAssessment, true);
  assert.equal(T.TEMPLATES.IMAGE.requiresApproval, false);
  assert.equal(T.TEMPLATES.PRESENTATION.supportsPowerPoint, true);
  assert.equal(T.TEMPLATES.ASSESSMENT.supportsAssessment, true);
  assert.equal(T.TEMPLATES.AI_CONTENT.defaultClassification, 'AI_GENERATED');
  assert.equal(T.TEMPLATES.VIDEO.supportsVideo, true);
});

test('DT3-13. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(T).sort(), ['TEMPLATES', 'TEMPLATE_IDS', 'getTemplate', 'isKnownTemplate', 'listTemplates'].sort());
});
