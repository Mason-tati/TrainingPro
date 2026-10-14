// WP-17 · D4 — Document metadata-field registry tests (immutable, 100% coverage).
// NOTE: the D4 field registry lives at lib/document/document-metadata-fields.js (the
// D2 metadata builder keeps document-metadata.js) — see the D4 report for the rationale.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const F = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-metadata-fields.js'));

const EXPECTED = ['title', 'subtitle', 'documentNumber', 'documentType', 'version', 'revision', 'status', 'workflow', 'classification', 'retention', 'owner', 'approver', 'reviewer', 'department', 'site', 'company', 'project', 'equipment', 'plant', 'workArea', 'discipline', 'language', 'country', 'region', 'author', 'createdDate', 'effectiveDate', 'reviewDate', 'expiryDate', 'supersedes', 'keywords', 'tags', 'hazards', 'controls', 'legislation', 'standards', 'trainingRequired', 'readAcknowledgement', 'electronicSignature', 'riskLevel', 'aiGenerated', 'aiModel', 'translationLanguage', 'attachments', 'images', 'videos', 'customFields'];
const FLAG_KEYS = ['required', 'searchable', 'sortable', 'filterable', 'exportable', 'auditable', 'editable', 'systemField', 'multiValue'];
const VALIDATION_KEYS = ['minLength', 'maxLength', 'min', 'max', 'regex', 'allowedValues'];
const RESERVED_KEYS = ['indexProfile', 'searchWeight', 'translationRule', 'aiProcessing', 'ocrProfile', 'integrationMapping', 'externalReference', 'complianceRule', 'retentionOverride', 'approvalRule'];
const DATA_TYPES = ['string', 'number', 'boolean', 'date', 'datetime', 'array', 'object', 'enum'];

test('DMF-1. registry has all expected fields with the full shape', () => {
  assert.deepEqual([...F.METADATA_FIELD_IDS].sort(), [...EXPECTED].sort());
  for (const id of F.METADATA_FIELD_IDS) {
    const f = F.METADATA_FIELDS[id];
    assert.equal(f.id, id);
    assert.equal(typeof f.displayName, 'string');
    assert.equal(typeof f.description, 'string');
    assert.ok(DATA_TYPES.includes(f.dataType), `${id} dataType valid`);
    for (const k of FLAG_KEYS) assert.equal(typeof f[k], 'boolean', `${id}.${k} boolean`);
    assert.ok('defaultValue' in f, `${id} has defaultValue`);
    assert.equal(typeof f.validation, 'object');
    assert.equal(typeof f.futureReserved, 'object');
  }
});

test('DMF-2. unique ids, no duplicates', () => {
  assert.equal(F.METADATA_FIELD_IDS.length, new Set(F.METADATA_FIELD_IDS).size);
  assert.equal(F.METADATA_FIELD_IDS.length, EXPECTED.length);
});

test('DMF-3. validation object: exactly the 6 nullable keys on every field', () => {
  for (const id of F.METADATA_FIELD_IDS) {
    const v = F.METADATA_FIELDS[id].validation;
    assert.deepEqual(Object.keys(v).sort(), [...VALIDATION_KEYS].sort(), `${id} validation keys`);
    for (const k of VALIDATION_KEYS) {
      const val = v[k];
      assert.ok(val === null || ['number', 'string', 'object'].includes(typeof val), `${id}.validation.${k} nullable`);
    }
  }
  // a couple of concrete validations are present
  assert.equal(F.METADATA_FIELDS.title.validation.maxLength, 160);
  assert.equal(F.METADATA_FIELDS.title.validation.minLength, 1);
  assert.deepEqual(F.METADATA_FIELDS.riskLevel.validation.allowedValues, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  assert.equal(F.METADATA_FIELDS.documentNumber.validation.regex, '^[A-Z0-9-]+$');
});

test('DMF-4. futureReserved object: exactly the reserved keys, all null', () => {
  for (const id of F.METADATA_FIELD_IDS) {
    const fr = F.METADATA_FIELDS[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DMF-5. deep frozen / immutable (registry, ids, each field, validation, futureReserved)', () => {
  assert.ok(Object.isFrozen(F.METADATA_FIELDS) && Object.isFrozen(F.METADATA_FIELD_IDS));
  for (const id of F.METADATA_FIELD_IDS) {
    assert.ok(Object.isFrozen(F.METADATA_FIELDS[id]));
    assert.ok(Object.isFrozen(F.METADATA_FIELDS[id].validation));
    assert.ok(Object.isFrozen(F.METADATA_FIELDS[id].futureReserved));
  }
  try { F.METADATA_FIELDS.HACK = {}; } catch { /* ok */ }
  try { F.METADATA_FIELDS.title.required = false; } catch { /* ok */ }
  try { F.METADATA_FIELDS.title.validation.maxLength = 1; } catch { /* ok */ }
  try { F.METADATA_FIELDS.title.futureReserved.aiProcessing = 'x'; } catch { /* ok */ }
  assert.equal(F.METADATA_FIELDS.HACK, undefined);
  assert.equal(F.METADATA_FIELDS.title.required, true);
  assert.equal(F.METADATA_FIELDS.title.validation.maxLength, 160);
  assert.equal(F.METADATA_FIELDS.title.futureReserved.aiProcessing, null);
});

test('DMF-6. getMetadataField: known lookup + unknown → most-restrictive UNKNOWN default', () => {
  assert.equal(F.getMetadataField('title').id, 'title');
  const d = F.getMetadataField('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Field');
  assert.equal(d.dataType, 'string');
  for (const k of FLAG_KEYS) assert.equal(d[k], false, `UNKNOWN.${k} false`);
  assert.equal(d.defaultValue, null);
  for (const k of VALIDATION_KEYS) assert.equal(d.validation[k], null, `UNKNOWN.validation.${k} null`);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null, `UNKNOWN.futureReserved.${k} null`);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(F.getMetadataField(bad).id, 'UNKNOWN');
});

test('DMF-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = F.getMetadataField('title');
  c.required = false; c.validation.maxLength = 1; c.futureReserved.indexProfile = 'x'; c.dataType = 'number';
  const c2 = F.getMetadataField('title');
  assert.equal(c2.required, true);
  assert.equal(c2.validation.maxLength, 160);
  assert.equal(c2.futureReserved.indexProfile, null);
  assert.equal(c2.dataType, 'string');
  assert.notEqual(c, c2);
  assert.notEqual(c.validation, c2.validation);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DMF-8. listMetadataFields: fresh array + fresh objects; never exposes the registry', () => {
  const a = F.listMetadataFields();
  const b = F.listMetadataFields();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].validation.maxLength = 1; a[0].futureReserved.indexProfile = 'x';
  assert.equal(F.listMetadataFields().length, EXPECTED.length);
  assert.notEqual(F.getMetadataField('title').id, 'mutated');
  for (const f of b) {
    assert.notEqual(f, F.METADATA_FIELDS[f.id], 'listed object is a copy');
    assert.notEqual(f.validation, F.METADATA_FIELDS[f.id].validation, 'listed validation is a copy');
  }
});

test('DMF-9. isKnownMetadataField: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(F.isKnownMetadataField('title'), true);
  assert.equal(F.isKnownMetadataField('UNKNOWN'), false, 'UNKNOWN safe default is not a known field');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(F.isKnownMetadataField(bad), false);
});

test('DMF-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => F.getMetadataField(bad));
    assert.doesNotThrow(() => F.isKnownMetadataField(bad));
  }
  assert.doesNotThrow(() => F.listMetadataFields());
});

test('DMF-11. registry integrity: flags meaningful; system + multi-value + default semantics', () => {
  // auditable + exportable are intentionally universal for metadata (all fields are
  // auditable and exportable); every other flag must vary across the registry.
  const UNIVERSAL_TRUE = ['auditable', 'exportable'];
  for (const k of FLAG_KEYS) {
    const vals = F.METADATA_FIELD_IDS.map((id) => F.METADATA_FIELDS[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    if (!UNIVERSAL_TRUE.includes(k)) assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  for (const k of UNIVERSAL_TRUE) {
    assert.ok(F.METADATA_FIELD_IDS.every((id) => F.METADATA_FIELDS[id][k] === true), `${k} true for every field`);
  }
  assert.equal(F.METADATA_FIELDS.documentNumber.systemField, true);
  assert.equal(F.METADATA_FIELDS.documentNumber.editable, false);
  assert.equal(F.METADATA_FIELDS.aiGenerated.systemField, true);
  assert.equal(F.METADATA_FIELDS.keywords.multiValue, true);
  assert.equal(F.METADATA_FIELDS.trainingRequired.defaultValue, false);
  assert.equal(F.METADATA_FIELDS.title.defaultValue, null, 'non-default field → null');
});

test('DMF-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(F).sort(), ['METADATA_FIELDS', 'METADATA_FIELD_IDS', 'getMetadataField', 'isKnownMetadataField', 'listMetadataFields'].sort());
});
