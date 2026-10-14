// WP-17 · D6 — Document approval-workflow registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const W = require(path.join(ROOT, 'lib', 'document', 'document-approval-workflows.js'));
const { APPROVAL_LEVEL_IDS } = require(path.join(ROOT, 'lib', 'document', 'approval-levels.js'));
const { DOCUMENT_STATUS_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-status.js'));

const EXPECTED = ['NONE', 'SIMPLE_REVIEW', 'SUPERVISOR_APPROVAL', 'TRAINING_MANAGER_APPROVAL', 'DOCUMENT_OWNER_APPROVAL', 'HSEQ_APPROVAL', 'MANAGER_APPROVAL', 'SITE_MANAGER_APPROVAL', 'MULTI_LEVEL_APPROVAL', 'SAFETY_CRITICAL_APPROVAL', 'HR_CONFIDENTIAL_APPROVAL', 'AI_CONTENT_APPROVAL', 'EXTERNAL_STANDARD_REVIEW', 'PERIODIC_REVIEW', 'EMERGENCY_CHANGE', 'ARCHIVE_APPROVAL', 'OBSOLETE_APPROVAL'];
const CATEGORIES = ['none', 'review', 'approval', 'safety', 'hr', 'ai', 'external', 'lifecycle', 'emergency'];
const FLAG_KEYS = ['allowSelfApproval', 'allowParallelApproval', 'allowDelegation', 'requiresReview', 'requiresChangeSummary', 'requiresEffectiveDate', 'requiresExpiryDate', 'requiresReadAcknowledgement', 'requiresElectronicSignature', 'requiresAudit', 'requiresVersionIncrement', 'requiresPublishedSource'];
const UNIVERSAL_TRUE = ['requiresAudit']; // every workflow is audited
const RESERVED_KEYS = ['notificationTemplate', 'escalationRule', 'delegationRule', 'signoffRule', 'evidenceRule', 'workflowEngineRule', 'integrationHook', 'slaPolicy', 'parallelPolicy', 'exceptionPolicy'];

test('DAW-1. registry has all expected workflows with the full shape', () => {
  assert.deepEqual([...W.DOCUMENT_APPROVAL_WORKFLOW_IDS].sort(), [...EXPECTED].sort());
  for (const id of W.DOCUMENT_APPROVAL_WORKFLOW_IDS) {
    const w = W.DOCUMENT_APPROVAL_WORKFLOWS[id];
    assert.equal(w.id, id);
    assert.equal(typeof w.displayName, 'string');
    assert.equal(typeof w.description, 'string');
    assert.equal(typeof w.requiredApprovalLevel, 'string');
    assert.ok(Array.isArray(w.requiredRoles) && Array.isArray(w.requiredPermissions));
    assert.equal(typeof w.minApprovers, 'number');
    for (const k of FLAG_KEYS) assert.equal(typeof w[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof w.defaultStatusBefore, 'string');
    assert.equal(typeof w.defaultStatusAfter, 'string');
    assert.equal(typeof w.futureReserved, 'object');
  }
});

test('DAW-2. unique ids, no duplicates', () => {
  assert.equal(W.DOCUMENT_APPROVAL_WORKFLOW_IDS.length, new Set(W.DOCUMENT_APPROVAL_WORKFLOW_IDS).size);
  assert.equal(W.DOCUMENT_APPROVAL_WORKFLOW_IDS.length, EXPECTED.length);
});

test('DAW-3. cross-validation: approval level, statuses, category, minApprovers, string arrays', () => {
  for (const id of W.DOCUMENT_APPROVAL_WORKFLOW_IDS) {
    const w = W.DOCUMENT_APPROVAL_WORKFLOWS[id];
    assert.ok(APPROVAL_LEVEL_IDS.includes(w.requiredApprovalLevel), `${id} requiredApprovalLevel known`);
    assert.ok(DOCUMENT_STATUS_IDS.includes(w.defaultStatusBefore), `${id} defaultStatusBefore known`);
    assert.ok(DOCUMENT_STATUS_IDS.includes(w.defaultStatusAfter), `${id} defaultStatusAfter known`);
    assert.ok(CATEGORIES.includes(w.category), `${id} category valid`);
    assert.ok(Number.isInteger(w.minApprovers) && w.minApprovers >= 0, `${id} minApprovers non-negative integer`);
    for (const r of w.requiredRoles) assert.equal(typeof r, 'string', `${id} role is string`);
    for (const p of w.requiredPermissions) assert.equal(typeof p, 'string', `${id} permission is string`);
  }
});

test('DAW-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of W.DOCUMENT_APPROVAL_WORKFLOW_IDS) {
    const fr = W.DOCUMENT_APPROVAL_WORKFLOWS[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DAW-5. deep frozen / immutable (registry, ids, each workflow, arrays, futureReserved)', () => {
  assert.ok(Object.isFrozen(W.DOCUMENT_APPROVAL_WORKFLOWS) && Object.isFrozen(W.DOCUMENT_APPROVAL_WORKFLOW_IDS));
  for (const id of W.DOCUMENT_APPROVAL_WORKFLOW_IDS) {
    const w = W.DOCUMENT_APPROVAL_WORKFLOWS[id];
    assert.ok(Object.isFrozen(w) && Object.isFrozen(w.requiredRoles) && Object.isFrozen(w.requiredPermissions) && Object.isFrozen(w.futureReserved));
  }
  try { W.DOCUMENT_APPROVAL_WORKFLOWS.HACK = {}; } catch { /* ok */ }
  try { W.DOCUMENT_APPROVAL_WORKFLOWS.MANAGER_APPROVAL.minApprovers = 99; } catch { /* ok */ }
  try { W.DOCUMENT_APPROVAL_WORKFLOWS.MANAGER_APPROVAL.requiredRoles.push('X'); } catch { /* ok */ }
  assert.equal(W.DOCUMENT_APPROVAL_WORKFLOWS.HACK, undefined);
  assert.equal(W.DOCUMENT_APPROVAL_WORKFLOWS.MANAGER_APPROVAL.minApprovers, 1);
  assert.deepEqual(W.DOCUMENT_APPROVAL_WORKFLOWS.MANAGER_APPROVAL.requiredRoles, ['MANAGER']);
});

test('DAW-6. getDocumentApprovalWorkflow: known + unknown → safe default (per spec)', () => {
  assert.equal(W.getDocumentApprovalWorkflow('MANAGER_APPROVAL').id, 'MANAGER_APPROVAL');
  const d = W.getDocumentApprovalWorkflow('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Approval Workflow');
  assert.equal(d.category, 'approval');
  assert.equal(d.requiredApprovalLevel, 'MANAGER');
  assert.deepEqual(d.requiredRoles, []);
  assert.deepEqual(d.requiredPermissions, []);
  assert.equal(d.minApprovers, 1);
  assert.equal(d.allowSelfApproval, false);
  assert.equal(d.allowParallelApproval, false);
  assert.equal(d.allowDelegation, false);
  assert.equal(d.requiresReview, true);
  assert.equal(d.requiresChangeSummary, true);
  assert.equal(d.requiresEffectiveDate, true);
  assert.equal(d.requiresExpiryDate, false);
  assert.equal(d.requiresReadAcknowledgement, false);
  assert.equal(d.requiresElectronicSignature, true);
  assert.equal(d.requiresAudit, true);
  assert.equal(d.requiresVersionIncrement, true);
  assert.equal(d.requiresPublishedSource, false);
  assert.equal(d.defaultStatusBefore, 'DRAFT');
  assert.equal(d.defaultStatusAfter, 'UNDER_APPROVAL');
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(W.getDocumentApprovalWorkflow(bad).id, 'UNKNOWN');
});

test('DAW-7. copy-on-read + mutation safety: fresh arrays; registry never changes', () => {
  const c = W.getDocumentApprovalWorkflow('MULTI_LEVEL_APPROVAL');
  c.requiredRoles.push('HACK'); c.requiredPermissions.push('x'); c.minApprovers = 99; c.futureReserved.slaPolicy = 'y';
  const c2 = W.getDocumentApprovalWorkflow('MULTI_LEVEL_APPROVAL');
  assert.deepEqual(c2.requiredRoles, ['MANAGER', 'SITE_MANAGER']);
  assert.deepEqual(c2.requiredPermissions, ['document.approve']);
  assert.equal(c2.minApprovers, 2);
  assert.equal(c2.futureReserved.slaPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.requiredRoles, c2.requiredRoles, 'fresh roles array each call');
  assert.notEqual(c.requiredPermissions, c2.requiredPermissions, 'fresh permissions array each call');
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DAW-8. listDocumentApprovalWorkflows: fresh array + fresh objects/arrays; never exposes registry', () => {
  const a = W.listDocumentApprovalWorkflows();
  const b = W.listDocumentApprovalWorkflows();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].requiredRoles.push('X'); a[0].futureReserved.slaPolicy = 'z';
  assert.equal(W.listDocumentApprovalWorkflows().length, EXPECTED.length);
  assert.notEqual(W.getDocumentApprovalWorkflow('NONE').id, 'mutated');
  for (const w of b) {
    assert.notEqual(w, W.DOCUMENT_APPROVAL_WORKFLOWS[w.id], 'listed object is a copy');
    assert.notEqual(w.requiredRoles, W.DOCUMENT_APPROVAL_WORKFLOWS[w.id].requiredRoles, 'listed roles array is a copy');
  }
});

test('DAW-9. isKnownDocumentApprovalWorkflow: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(W.isKnownDocumentApprovalWorkflow('MANAGER_APPROVAL'), true);
  assert.equal(W.isKnownDocumentApprovalWorkflow('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(W.isKnownDocumentApprovalWorkflow(bad), false);
});

test('DAW-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => W.getDocumentApprovalWorkflow(bad));
    assert.doesNotThrow(() => W.isKnownDocumentApprovalWorkflow(bad));
  }
  assert.doesNotThrow(() => W.listDocumentApprovalWorkflows());
});

test('DAW-11. registry integrity: gating flags meaningful; all categories represented', () => {
  for (const k of FLAG_KEYS) {
    const vals = W.DOCUMENT_APPROVAL_WORKFLOW_IDS.map((id) => W.DOCUMENT_APPROVAL_WORKFLOWS[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    if (!UNIVERSAL_TRUE.includes(k)) assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  for (const k of UNIVERSAL_TRUE) {
    assert.ok(W.DOCUMENT_APPROVAL_WORKFLOW_IDS.every((id) => W.DOCUMENT_APPROVAL_WORKFLOWS[id][k] === true), `${k} true for every workflow`);
  }
  const usedCats = new Set(W.DOCUMENT_APPROVAL_WORKFLOW_IDS.map((id) => W.DOCUMENT_APPROVAL_WORKFLOWS[id].category));
  for (const c of CATEGORIES) assert.ok(usedCats.has(c), `category ${c} is represented`);
  assert.equal(W.DOCUMENT_APPROVAL_WORKFLOWS.NONE.minApprovers, 0, 'NONE requires no approvers');
  assert.equal(W.DOCUMENT_APPROVAL_WORKFLOWS.MULTI_LEVEL_APPROVAL.minApprovers, 2);
});

test('DAW-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(W).sort(), ['DOCUMENT_APPROVAL_WORKFLOWS', 'DOCUMENT_APPROVAL_WORKFLOW_IDS', 'getDocumentApprovalWorkflow', 'isKnownDocumentApprovalWorkflow', 'listDocumentApprovalWorkflows'].sort());
});
