// WP-17 · D5 — Document-relationship registry tests (immutable, reciprocal, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const R = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-relationships.js'));

const EXPECTED = ['SUPERSEDES', 'SUPERSEDED_BY', 'PARENT', 'CHILD', 'RELATED', 'REFERENCE', 'ATTACHMENT', 'TRANSLATION_OF', 'TRANSLATED_BY', 'DERIVED_FROM', 'GENERATED_FROM', 'GENERATES', 'REQUIRES', 'REQUIRED_BY', 'IMPLEMENTS', 'IMPLEMENTED_BY', 'SUPPORTED_BY', 'SUPPORTS', 'REPLACES', 'REPLACED_BY', 'CITED_BY', 'CITES', 'DUPLICATE_OF', 'ALTERNATE_VERSION', 'SOURCE_DOCUMENT', 'OUTPUT_DOCUMENT', 'TRAINING_PACKAGE', 'ASSESSMENT_FOR', 'RISK_ASSESSMENT_FOR', 'WORK_INSTRUCTION_FOR', 'POLICY_FOR', 'PROCEDURE_FOR', 'STANDARD_FOR'];
const FLAG_KEYS = ['directional', 'allowsMultiple', 'requiresSameDocumentType', 'requiresApproval', 'requiresVersionMatch', 'requiresPublishedSource', 'requiresPublishedTarget'];
const RESERVED_KEYS = ['validationRule', 'workflowRule', 'approvalRule', 'dependencyRule', 'impactRule', 'notificationRule', 'aiRule', 'graphRule', 'integrationRule', 'visualisationRule'];

test('DR-1. registry has all expected relationships with the full shape', () => {
  assert.deepEqual([...R.DOCUMENT_RELATIONSHIP_IDS].sort(), [...EXPECTED].sort());
  for (const id of R.DOCUMENT_RELATIONSHIP_IDS) {
    const r = R.DOCUMENT_RELATIONSHIPS[id];
    assert.equal(r.id, id);
    assert.equal(typeof r.displayName, 'string');
    assert.equal(typeof r.description, 'string');
    for (const k of FLAG_KEYS) assert.equal(typeof r[k], 'boolean', `${id}.${k} boolean`);
    assert.ok(r.inverseRelationship === null || typeof r.inverseRelationship === 'string', `${id}.inverseRelationship null|string`);
    assert.equal(typeof r.futureReserved, 'object');
  }
});

test('DR-2. unique ids, no duplicates', () => {
  assert.equal(R.DOCUMENT_RELATIONSHIP_IDS.length, new Set(R.DOCUMENT_RELATIONSHIP_IDS).size);
  assert.equal(R.DOCUMENT_RELATIONSHIP_IDS.length, EXPECTED.length);
});

test('DR-3. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of R.DOCUMENT_RELATIONSHIP_IDS) {
    const fr = R.DOCUMENT_RELATIONSHIPS[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DR-4. deep frozen / immutable (registry, ids, each relationship, futureReserved)', () => {
  assert.ok(Object.isFrozen(R.DOCUMENT_RELATIONSHIPS) && Object.isFrozen(R.DOCUMENT_RELATIONSHIP_IDS));
  for (const id of R.DOCUMENT_RELATIONSHIP_IDS) {
    assert.ok(Object.isFrozen(R.DOCUMENT_RELATIONSHIPS[id]));
    assert.ok(Object.isFrozen(R.DOCUMENT_RELATIONSHIPS[id].futureReserved));
  }
  try { R.DOCUMENT_RELATIONSHIPS.HACK = {}; } catch { /* ok */ }
  try { R.DOCUMENT_RELATIONSHIPS.PARENT.inverseRelationship = 'X'; } catch { /* ok */ }
  try { R.DOCUMENT_RELATIONSHIPS.PARENT.futureReserved.aiRule = 'x'; } catch { /* ok */ }
  assert.equal(R.DOCUMENT_RELATIONSHIPS.HACK, undefined);
  assert.equal(R.DOCUMENT_RELATIONSHIPS.PARENT.inverseRelationship, 'CHILD');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.PARENT.futureReserved.aiRule, null);
});

test('DR-5. inverse validation: every inverse exists and is reciprocal', () => {
  for (const id of R.DOCUMENT_RELATIONSHIP_IDS) {
    const inv = R.DOCUMENT_RELATIONSHIPS[id].inverseRelationship;
    if (inv === null) continue; // relationships without an inverse are allowed
    assert.ok(R.isKnownDocumentRelationship(inv), `${id} inverse ${inv} exists`);
    assert.equal(R.DOCUMENT_RELATIONSHIPS[inv].inverseRelationship, id, `${id} <-> ${inv} reciprocal`);
  }
  // spot-check the documented pairs + symmetric self-inverses
  assert.equal(R.DOCUMENT_RELATIONSHIPS.PARENT.inverseRelationship, 'CHILD');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.CHILD.inverseRelationship, 'PARENT');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.SUPERSEDES.inverseRelationship, 'SUPERSEDED_BY');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.SUPERSEDED_BY.inverseRelationship, 'SUPERSEDES');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.CITES.inverseRelationship, 'CITED_BY');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.CITED_BY.inverseRelationship, 'CITES');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.RELATED.inverseRelationship, 'RELATED', 'symmetric self-inverse');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.DUPLICATE_OF.inverseRelationship, 'DUPLICATE_OF');
  assert.equal(R.DOCUMENT_RELATIONSHIPS.POLICY_FOR.inverseRelationship, null, 'purpose link has no inverse');
});

test('DR-6. getDocumentRelationship: known lookup + unknown → most-restrictive UNKNOWN default', () => {
  assert.equal(R.getDocumentRelationship('PARENT').id, 'PARENT');
  const d = R.getDocumentRelationship('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Relationship');
  assert.equal(d.directional, false);
  assert.equal(d.inverseRelationship, null);
  assert.equal(d.allowsMultiple, false);
  assert.equal(d.requiresSameDocumentType, false);
  assert.equal(d.requiresApproval, true, 'unknown → approval required');
  assert.equal(d.requiresVersionMatch, false);
  assert.equal(d.requiresPublishedSource, false);
  assert.equal(d.requiresPublishedTarget, false);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(R.getDocumentRelationship(bad).id, 'UNKNOWN');
});

test('DR-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = R.getDocumentRelationship('PARENT');
  c.directional = false; c.inverseRelationship = 'X'; c.futureReserved.graphRule = 'x';
  const c2 = R.getDocumentRelationship('PARENT');
  assert.equal(c2.directional, true);
  assert.equal(c2.inverseRelationship, 'CHILD');
  assert.equal(c2.futureReserved.graphRule, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DR-8. listDocumentRelationships: fresh array + fresh objects; never exposes registry', () => {
  const a = R.listDocumentRelationships();
  const b = R.listDocumentRelationships();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.graphRule = 'x';
  assert.equal(R.listDocumentRelationships().length, EXPECTED.length);
  assert.notEqual(R.getDocumentRelationship('PARENT').id, 'mutated');
  for (const r of b) assert.notEqual(r, R.DOCUMENT_RELATIONSHIPS[r.id], 'listed object is a copy');
});

test('DR-9. isKnownDocumentRelationship: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(R.isKnownDocumentRelationship('PARENT'), true);
  assert.equal(R.isKnownDocumentRelationship('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(R.isKnownDocumentRelationship(bad), false);
});

test('DR-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => R.getDocumentRelationship(bad));
    assert.doesNotThrow(() => R.isKnownDocumentRelationship(bad));
  }
  assert.doesNotThrow(() => R.listDocumentRelationships());
});

test('DR-11. registry integrity: every gating flag varies; directionality semantics', () => {
  for (const k of FLAG_KEYS) {
    const vals = R.DOCUMENT_RELATIONSHIP_IDS.map((id) => R.DOCUMENT_RELATIONSHIPS[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  // symmetric relationships are non-directional and self-inverse
  for (const id of ['RELATED', 'DUPLICATE_OF', 'ALTERNATE_VERSION']) {
    assert.equal(R.DOCUMENT_RELATIONSHIPS[id].directional, false, `${id} non-directional`);
    assert.equal(R.DOCUMENT_RELATIONSHIPS[id].inverseRelationship, id, `${id} self-inverse`);
  }
  assert.equal(R.DOCUMENT_RELATIONSHIPS.SUPERSEDES.requiresApproval, true);
  assert.equal(R.DOCUMENT_RELATIONSHIPS.TRANSLATION_OF.requiresVersionMatch, true);
});

test('DR-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(R).sort(), ['DOCUMENT_RELATIONSHIPS', 'DOCUMENT_RELATIONSHIP_IDS', 'getDocumentRelationship', 'isKnownDocumentRelationship', 'listDocumentRelationships'].sort());
});
