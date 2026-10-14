// WP-17 · D14 — Document workflow registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const W = require(path.join(ROOT, 'lib', 'document', 'document-workflows.js'));
const { DOCUMENT_STATUS_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-status.js'));

const EXPECTED = ['NONE', 'STANDARD', 'FAST_TRACK', 'CONTROLLED_DOCUMENT', 'ISO_DOCUMENT', 'TRAINING_DOCUMENT', 'RISK_ASSESSMENT', 'WORK_INSTRUCTION', 'STANDARD_OPERATING_PROCEDURE', 'POLICY', 'PROCEDURE', 'FORM', 'CHECKLIST', 'TRANSLATION', 'AI_GENERATED', 'CONTROLLED_COPY', 'EMERGENCY_RELEASE', 'READ_ACKNOWLEDGEMENT', 'ELECTRONIC_SIGNATURE', 'PERIODIC_REVIEW', 'CHANGE_MANAGEMENT', 'OBSOLESCENCE', 'ARCHIVAL'];
const VALID_CATEGORIES = ['none', 'standard', 'controlled', 'training', 'risk', 'quality', 'policy', 'procedure', 'translation', 'ai', 'compliance', 'emergency', 'archival'];
const BOOL_KEYS = ['requiresReview', 'requiresApproval', 'requiresPublication', 'requiresReadAcknowledgement', 'requiresElectronicSignature', 'requiresVersionIncrement', 'requiresDocumentNumber', 'requiresOwner', 'requiresReviewer', 'requiresApprover', 'requiresPublishedSource', 'allowsParallelReview', 'allowsDraftRevision', 'supportsRollback', 'supportsEmergencyOverride', 'auditRequired'];
const RESERVED_KEYS = ['approvalPolicy', 'reviewPolicy', 'routingPolicy', 'notificationPolicy', 'automationPolicy', 'workflowEnginePolicy', 'escalationPolicy', 'aiPolicy', 'integrationPolicy', 'extensionPolicy'];

test('DW-1. registry has all expected workflows with the full shape', () => {
  assert.deepEqual([...W.DOCUMENT_WORKFLOW_IDS].sort(), [...EXPECTED].sort());
  for (const id of W.DOCUMENT_WORKFLOW_IDS) {
    const w = W.DOCUMENT_WORKFLOWS[id];
    assert.equal(w.id, id);
    assert.equal(typeof w.displayName, 'string');
    assert.equal(typeof w.description, 'string');
    assert.equal(typeof w.category, 'string');
    assert.equal(typeof w.initialStatus, 'string');
    assert.equal(typeof w.finalStatus, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof w[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof w.futureReserved, 'object');
  }
});

test('DW-2. unique ids, no duplicates', () => {
  assert.equal(W.DOCUMENT_WORKFLOW_IDS.length, new Set(W.DOCUMENT_WORKFLOW_IDS).size);
  assert.equal(W.DOCUMENT_WORKFLOW_IDS.length, EXPECTED.length);
});

test('DW-3. cross-validation: category valid; initial/final status exist in DOCUMENT_STATUS_IDS', () => {
  for (const id of W.DOCUMENT_WORKFLOW_IDS) {
    const w = W.DOCUMENT_WORKFLOWS[id];
    assert.ok(VALID_CATEGORIES.includes(w.category), `${id} category valid`);
    assert.ok(DOCUMENT_STATUS_IDS.includes(w.initialStatus), `${id} initialStatus known`);
    assert.ok(DOCUMENT_STATUS_IDS.includes(w.finalStatus), `${id} finalStatus known`);
  }
});

test('DW-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of W.DOCUMENT_WORKFLOW_IDS) {
    const fr = W.DOCUMENT_WORKFLOWS[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DW-5. deep frozen / immutable (registry, ids, each workflow, futureReserved)', () => {
  assert.ok(Object.isFrozen(W.DOCUMENT_WORKFLOWS) && Object.isFrozen(W.DOCUMENT_WORKFLOW_IDS));
  for (const id of W.DOCUMENT_WORKFLOW_IDS) {
    assert.ok(Object.isFrozen(W.DOCUMENT_WORKFLOWS[id]));
    assert.ok(Object.isFrozen(W.DOCUMENT_WORKFLOWS[id].futureReserved));
  }
  try { W.DOCUMENT_WORKFLOWS.HACK = {}; } catch { /* ok */ }
  try { W.DOCUMENT_WORKFLOWS.CONTROLLED_DOCUMENT.requiresReview = false; } catch { /* ok */ }
  try { W.DOCUMENT_WORKFLOWS.CONTROLLED_DOCUMENT.futureReserved.approvalPolicy = 'x'; } catch { /* ok */ }
  assert.equal(W.DOCUMENT_WORKFLOWS.HACK, undefined);
  assert.equal(W.DOCUMENT_WORKFLOWS.CONTROLLED_DOCUMENT.requiresReview, true);
  assert.equal(W.DOCUMENT_WORKFLOWS.CONTROLLED_DOCUMENT.futureReserved.approvalPolicy, null);
});

test('DW-6. getDocumentWorkflow: known + unknown → most-controlled safe default (exact spec)', () => {
  assert.equal(W.getDocumentWorkflow('STANDARD').id, 'STANDARD');
  const d = W.getDocumentWorkflow('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Workflow');
  assert.equal(d.category, 'controlled');
  assert.equal(d.initialStatus, 'DRAFT');
  assert.equal(d.finalStatus, 'ARCHIVED');
  const EXPECT = {
    requiresReview: true, requiresApproval: true, requiresPublication: true, requiresReadAcknowledgement: false,
    requiresElectronicSignature: false, requiresVersionIncrement: true, requiresDocumentNumber: true, requiresOwner: true,
    requiresReviewer: true, requiresApprover: true, requiresPublishedSource: false, allowsParallelReview: false,
    allowsDraftRevision: false, supportsRollback: false, supportsEmergencyOverride: false, auditRequired: true,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(W.getDocumentWorkflow(bad).id, 'UNKNOWN');
});

test('DW-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = W.getDocumentWorkflow('CONTROLLED_DOCUMENT');
  c.requiresReview = false; c.initialStatus = 'X'; c.futureReserved.approvalPolicy = 'y';
  const c2 = W.getDocumentWorkflow('CONTROLLED_DOCUMENT');
  assert.equal(c2.requiresReview, true);
  assert.equal(c2.initialStatus, 'DRAFT');
  assert.equal(c2.futureReserved.approvalPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DW-8. listDocumentWorkflows: fresh array + fresh objects; never exposes the registry', () => {
  const a = W.listDocumentWorkflows();
  const b = W.listDocumentWorkflows();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.approvalPolicy = 'z';
  assert.equal(W.listDocumentWorkflows().length, EXPECTED.length);
  assert.notEqual(W.getDocumentWorkflow('NONE').id, 'mutated');
  for (const w of b) assert.notEqual(w, W.DOCUMENT_WORKFLOWS[w.id], 'listed object is a copy');
});

test('DW-9. isKnownDocumentWorkflow: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(W.isKnownDocumentWorkflow('STANDARD'), true);
  assert.equal(W.isKnownDocumentWorkflow('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(W.isKnownDocumentWorkflow(bad), false);
});

test('DW-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => W.getDocumentWorkflow(bad));
    assert.doesNotThrow(() => W.isKnownDocumentWorkflow(bad));
  }
  assert.doesNotThrow(() => W.listDocumentWorkflows());
});

test('DW-11. registry integrity: every boolean varies; all categories represented; NONE deny-all', () => {
  for (const k of BOOL_KEYS) {
    const vals = W.DOCUMENT_WORKFLOW_IDS.map((id) => W.DOCUMENT_WORKFLOWS[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(W.DOCUMENT_WORKFLOW_IDS.map((id) => W.DOCUMENT_WORKFLOWS[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  for (const k of BOOL_KEYS) assert.equal(W.DOCUMENT_WORKFLOWS.NONE[k], false, `NONE.${k} false`);
  assert.equal(W.DOCUMENT_WORKFLOWS.OBSOLESCENCE.finalStatus, 'OBSOLETE');
  assert.equal(W.DOCUMENT_WORKFLOWS.ARCHIVAL.finalStatus, 'ARCHIVED');
  assert.equal(W.DOCUMENT_WORKFLOWS.EMERGENCY_RELEASE.supportsEmergencyOverride, true);
});

test('DW-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(W).sort(), ['DOCUMENT_WORKFLOWS', 'DOCUMENT_WORKFLOW_IDS', 'getDocumentWorkflow', 'isKnownDocumentWorkflow', 'listDocumentWorkflows'].sort());
});
