// WP-17 · D1 — Document-type registry tests (immutability, copy-on-read, coverage).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const T = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-types.js'));

const EXPECTED = ['SOP', 'WORK_INSTRUCTION', 'TRAINING_MANUAL', 'POLICY', 'PROCEDURE', 'STANDARD', 'FORM', 'CHECKLIST', 'RISK_ASSESSMENT', 'JSA', 'SWMS', 'PRESENTATION', 'HANDBOOK', 'TOOLBOX_TALK', 'AI_CONTENT', 'IMAGE', 'VIDEO', 'ASSESSMENT', 'REFERENCE', 'EXTERNAL_STANDARD'];
const FLAGS = ['requiresApproval', 'requiresVersioning', 'requiresReview', 'supportsTranslation', 'supportsTraining', 'supportsRiskAssessment', 'supportsAI', 'supportsAttachments', 'supportsWorkflow', 'supportsReadAcknowledgement', 'supportsElectronicSignoff'];
const UNIVERSAL_TRUE = ['supportsAttachments']; // present on every type

test('DT-1. registry has all expected types with the full shape', () => {
  assert.deepEqual([...T.DOCUMENT_TYPE_IDS].sort(), [...EXPECTED].sort());
  for (const id of T.DOCUMENT_TYPE_IDS) {
    const t = T.DOCUMENT_TYPES[id];
    assert.equal(t.id, id);
    assert.equal(typeof t.displayName, 'string');
    assert.equal(typeof t.description, 'string');
    assert.ok(T.CATEGORIES.includes(t.category), `${id} category is known`);
    for (const f of FLAGS) assert.equal(typeof t[f], 'boolean', `${id}.${f} is boolean`);
  }
});

test('DT-2. unique ids', () => {
  assert.equal(T.DOCUMENT_TYPE_IDS.length, new Set(T.DOCUMENT_TYPE_IDS).size);
  assert.equal(T.DOCUMENT_TYPE_IDS.length, EXPECTED.length);
});

test('DT-3. deep frozen / immutable (registry, ids, categories, each entry)', () => {
  assert.ok(Object.isFrozen(T.DOCUMENT_TYPES) && Object.isFrozen(T.DOCUMENT_TYPE_IDS) && Object.isFrozen(T.CATEGORIES));
  for (const id of T.DOCUMENT_TYPE_IDS) assert.ok(Object.isFrozen(T.DOCUMENT_TYPES[id]));
  try { T.DOCUMENT_TYPES.HACK = {}; } catch { /* ok */ }
  try { T.DOCUMENT_TYPES.SOP.requiresApproval = false; } catch { /* ok */ }
  try { T.CATEGORIES.push('x'); } catch { /* ok */ }
  assert.equal(T.DOCUMENT_TYPES.HACK, undefined);
  assert.equal(T.DOCUMENT_TYPES.SOP.requiresApproval, true);
});

test('DT-4. getDocumentType: known + unknown → safe restrictive default; copy-on-read', () => {
  assert.equal(T.getDocumentType('SOP').id, 'SOP');
  const d = T.getDocumentType('NOPE');
  assert.equal(d.id, 'unknown');
  assert.equal(d.requiresApproval, true, 'unknown → restrictive');
  assert.equal(d.requiresVersioning, true);
  assert.equal(d.requiresReview, true);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(T.getDocumentType(bad).id, 'unknown');
  // mutating the returned copy never affects the registry
  const c = T.getDocumentType('SOP');
  c.requiresApproval = false; c.displayName = 'x';
  assert.equal(T.DOCUMENT_TYPES.SOP.requiresApproval, true);
  assert.notEqual(c, T.DOCUMENT_TYPES.SOP);
});

test('DT-5. listDocumentTypes: fresh array + fresh copies; never throws', () => {
  const a = T.listDocumentTypes();
  const b = T.listDocumentTypes();
  assert.notEqual(a, b, 'fresh array each call');
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated';
  assert.equal(T.listDocumentTypes().length, EXPECTED.length);
  assert.notEqual(T.getDocumentType('SOP').id, 'mutated');
  for (const bad of [undefined, null, {}, [], 5, Symbol('x')]) assert.doesNotThrow(() => T.getDocumentType(bad));
});

test('DT-6. registry consistency: every capability is meaningful (used + not universal)', () => {
  for (const f of FLAGS) {
    const vals = T.DOCUMENT_TYPE_IDS.map((id) => T.DOCUMENT_TYPES[id][f]);
    assert.ok(vals.includes(true), `${f} is true for at least one type`);
    if (!UNIVERSAL_TRUE.includes(f)) assert.ok(vals.includes(false), `${f} is false for at least one type`);
  }
  assert.equal(T.DOCUMENT_TYPES.SOP.category, 'controlled');
  assert.equal(T.DOCUMENT_TYPES.IMAGE.category, 'media');
  assert.equal(T.DOCUMENT_TYPES.AI_CONTENT.category, 'ai');
  for (const c of T.CATEGORIES) assert.equal(typeof c, 'string');
});
