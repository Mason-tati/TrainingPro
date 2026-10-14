// WP-17 · D1 — Document-status registry tests.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-status.js'));

const EXPECTED = ['DRAFT', 'IN_REVIEW', 'UNDER_APPROVAL', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED', 'OBSOLETE'];
const FLAGS = ['editable', 'published', 'terminal', 'requiresApproval', 'requiresReview'];

test('DS-1. registry has all expected statuses with the full shape', () => {
  assert.deepEqual([...S.DOCUMENT_STATUS_IDS].sort(), [...EXPECTED].sort());
  for (const id of S.DOCUMENT_STATUS_IDS) {
    const s = S.DOCUMENT_STATUSES[id];
    assert.equal(s.id, id);
    assert.equal(typeof s.displayName, 'string');
    for (const f of FLAGS) assert.equal(typeof s[f], 'boolean', `${id}.${f} boolean`);
  }
});

test('DS-2. unique ids', () => {
  assert.equal(S.DOCUMENT_STATUS_IDS.length, new Set(S.DOCUMENT_STATUS_IDS).size);
  assert.equal(S.DOCUMENT_STATUS_IDS.length, EXPECTED.length);
});

test('DS-3. deep frozen / immutable', () => {
  assert.ok(Object.isFrozen(S.DOCUMENT_STATUSES) && Object.isFrozen(S.DOCUMENT_STATUS_IDS));
  for (const id of S.DOCUMENT_STATUS_IDS) assert.ok(Object.isFrozen(S.DOCUMENT_STATUSES[id]));
  try { S.DOCUMENT_STATUSES.HACK = {}; } catch { /* ok */ }
  try { S.DOCUMENT_STATUSES.DRAFT.editable = false; } catch { /* ok */ }
  assert.equal(S.DOCUMENT_STATUSES.HACK, undefined);
  assert.equal(S.DOCUMENT_STATUSES.DRAFT.editable, true);
});

test('DS-4. known semantics: only DRAFT editable; only PUBLISHED published; terminals terminal', () => {
  assert.equal(S.DOCUMENT_STATUSES.DRAFT.editable, true);
  assert.equal(S.DOCUMENT_STATUSES.PUBLISHED.published, true);
  assert.equal(S.DOCUMENT_STATUSES.IN_REVIEW.requiresReview, true);
  assert.equal(S.DOCUMENT_STATUSES.UNDER_APPROVAL.requiresApproval, true);
  for (const t of ['SUPERSEDED', 'ARCHIVED', 'OBSOLETE']) assert.equal(S.DOCUMENT_STATUSES[t].terminal, true);
  assert.equal(S.DOCUMENT_STATUSES.PUBLISHED.editable, false, 'published not editable');
});

test('DS-5. getDocumentStatus: known + unknown → safe non-editable/non-published default; copy-on-read', () => {
  assert.equal(S.getDocumentStatus('DRAFT').id, 'DRAFT');
  const d = S.getDocumentStatus('NOPE');
  assert.equal(d.id, 'unknown');
  assert.equal(d.editable, false);
  assert.equal(d.published, false);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(S.getDocumentStatus(bad).id, 'unknown');
  const c = S.getDocumentStatus('DRAFT');
  c.editable = false;
  assert.equal(S.DOCUMENT_STATUSES.DRAFT.editable, true);
  assert.notEqual(c, S.DOCUMENT_STATUSES.DRAFT);
});

test('DS-6. listDocumentStatuses: fresh array + copies; never throws; consistency', () => {
  const a = S.listDocumentStatuses();
  const b = S.listDocumentStatuses();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated';
  assert.equal(S.listDocumentStatuses().length, EXPECTED.length);
  for (const f of FLAGS) {
    const vals = S.DOCUMENT_STATUS_IDS.map((id) => S.DOCUMENT_STATUSES[id][f]);
    assert.ok(vals.includes(true) && vals.includes(false), `${f} varies across statuses`);
  }
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => S.getDocumentStatus(bad));
});
