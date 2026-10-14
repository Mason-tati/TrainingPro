// WP-17 · D17 — Document compliance/standards registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const C = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-compliance.js'));

const EXPECTED = ['NONE', 'ISO9001', 'ISO14001', 'ISO45001', 'ISO27001', 'ISO31000', 'ISO55001', 'SOC2', 'GDPR', 'AU_PRIVACY_ACT', 'WHS_ACT', 'MINING_REGULATIONS', 'ICMM', 'TSM', 'COMPANY_STANDARD', 'SITE_STANDARD', 'PROJECT_STANDARD', 'CUSTOM'];
const VALID_CATEGORIES = ['none', 'quality', 'environment', 'safety', 'security', 'privacy', 'risk', 'asset', 'industry', 'corporate', 'site', 'project', 'custom'];
const BOOL_KEYS = ['requiresDocumentControl', 'requiresVersionControl', 'requiresApproval', 'requiresReview', 'requiresAudit', 'requiresRetention', 'requiresTraining', 'requiresReadAcknowledgement'];
const RESERVED_KEYS = ['auditPolicy', 'reviewPolicy', 'retentionPolicy', 'trainingPolicy', 'approvalPolicy', 'aiPolicy', 'workflowPolicy', 'integrationPolicy', 'reportingPolicy', 'extensionPolicy'];

test('DC-1. registry has all expected frameworks with the full shape', () => {
  assert.deepEqual([...C.DOCUMENT_COMPLIANCE_IDS].sort(), [...EXPECTED].sort());
  for (const id of C.DOCUMENT_COMPLIANCE_IDS) {
    const c = C.DOCUMENT_COMPLIANCE[id];
    assert.equal(c.id, id);
    assert.equal(typeof c.displayName, 'string');
    assert.equal(typeof c.description, 'string');
    assert.equal(typeof c.category, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof c[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof c.futureReserved, 'object');
  }
});

test('DC-2. unique ids, no duplicates', () => {
  assert.equal(C.DOCUMENT_COMPLIANCE_IDS.length, new Set(C.DOCUMENT_COMPLIANCE_IDS).size);
  assert.equal(C.DOCUMENT_COMPLIANCE_IDS.length, EXPECTED.length);
});

test('DC-3. cross-validation: every category is one of VALID_CATEGORIES', () => {
  for (const id of C.DOCUMENT_COMPLIANCE_IDS) {
    assert.ok(VALID_CATEGORIES.includes(C.DOCUMENT_COMPLIANCE[id].category), `${id} category valid`);
  }
});

test('DC-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of C.DOCUMENT_COMPLIANCE_IDS) {
    const fr = C.DOCUMENT_COMPLIANCE[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DC-5. deep frozen / immutable (registry, ids, each framework, futureReserved)', () => {
  assert.ok(Object.isFrozen(C.DOCUMENT_COMPLIANCE) && Object.isFrozen(C.DOCUMENT_COMPLIANCE_IDS));
  for (const id of C.DOCUMENT_COMPLIANCE_IDS) {
    assert.ok(Object.isFrozen(C.DOCUMENT_COMPLIANCE[id]));
    assert.ok(Object.isFrozen(C.DOCUMENT_COMPLIANCE[id].futureReserved));
  }
  try { C.DOCUMENT_COMPLIANCE.HACK = {}; } catch { /* ok */ }
  try { C.DOCUMENT_COMPLIANCE.ISO9001.requiresAudit = false; } catch { /* ok */ }
  try { C.DOCUMENT_COMPLIANCE.ISO9001.futureReserved.auditPolicy = 'x'; } catch { /* ok */ }
  assert.equal(C.DOCUMENT_COMPLIANCE.HACK, undefined);
  assert.equal(C.DOCUMENT_COMPLIANCE.ISO9001.requiresAudit, true);
  assert.equal(C.DOCUMENT_COMPLIANCE.ISO9001.futureReserved.auditPolicy, null);
});

test('DC-6. getDocumentCompliance: known + unknown → safe default (exact spec)', () => {
  assert.equal(C.getDocumentCompliance('ISO9001').id, 'ISO9001');
  const d = C.getDocumentCompliance('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Compliance');
  assert.equal(d.category, 'corporate');
  const EXPECT = {
    requiresDocumentControl: true, requiresVersionControl: true, requiresApproval: true, requiresReview: true,
    requiresAudit: true, requiresRetention: true, requiresTraining: false, requiresReadAcknowledgement: false,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(C.getDocumentCompliance(bad).id, 'UNKNOWN');
});

test('DC-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = C.getDocumentCompliance('ISO9001');
  c.requiresAudit = false; c.category = 'none'; c.futureReserved.auditPolicy = 'y';
  const c2 = C.getDocumentCompliance('ISO9001');
  assert.equal(c2.requiresAudit, true);
  assert.equal(c2.category, 'quality');
  assert.equal(c2.futureReserved.auditPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DC-8. listDocumentCompliance: fresh array + fresh objects; never exposes the registry', () => {
  const a = C.listDocumentCompliance();
  const b = C.listDocumentCompliance();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.auditPolicy = 'z';
  assert.equal(C.listDocumentCompliance().length, EXPECTED.length);
  assert.notEqual(C.getDocumentCompliance('NONE').id, 'mutated');
  for (const c of b) assert.notEqual(c, C.DOCUMENT_COMPLIANCE[c.id], 'listed object is a copy');
});

test('DC-9. isKnownDocumentCompliance: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(C.isKnownDocumentCompliance('ISO9001'), true);
  assert.equal(C.isKnownDocumentCompliance('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(C.isKnownDocumentCompliance(bad), false);
});

test('DC-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => C.getDocumentCompliance(bad));
    assert.doesNotThrow(() => C.isKnownDocumentCompliance(bad));
  }
  assert.doesNotThrow(() => C.listDocumentCompliance());
});

test('DC-11. registry integrity: every boolean varies; all categories represented; NONE deny-all', () => {
  for (const k of BOOL_KEYS) {
    const vals = C.DOCUMENT_COMPLIANCE_IDS.map((id) => C.DOCUMENT_COMPLIANCE[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(C.DOCUMENT_COMPLIANCE_IDS.map((id) => C.DOCUMENT_COMPLIANCE[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  for (const k of BOOL_KEYS) assert.equal(C.DOCUMENT_COMPLIANCE.NONE[k], false, `NONE.${k} false`);
  assert.equal(C.DOCUMENT_COMPLIANCE.ISO45001.requiresReadAcknowledgement, true);
  assert.equal(C.DOCUMENT_COMPLIANCE.WHS_ACT.requiresTraining, true);
});

test('DC-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(C).sort(), ['DOCUMENT_COMPLIANCE', 'DOCUMENT_COMPLIANCE_IDS', 'getDocumentCompliance', 'isKnownDocumentCompliance', 'listDocumentCompliance'].sort());
});
