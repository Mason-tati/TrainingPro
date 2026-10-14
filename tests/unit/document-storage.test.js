// WP-17 · D12 — Document storage registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const S = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-storage.js'));

const EXPECTED = ['NONE', 'LOCAL_PRIVATE', 'LOCAL_PUBLIC', 'DATABASE_BLOB', 'OBJECT_STORAGE', 'S3_STANDARD', 'S3_INFREQUENT_ACCESS', 'S3_GLACIER', 'AZURE_BLOB', 'GCP_BUCKET', 'NETWORK_SHARE', 'BEESTATION', 'ARCHIVE_STORAGE', 'TEMPORARY_STORAGE', 'AI_GENERATED_STORAGE', 'TRANSLATION_STORAGE', 'EVIDENCE_STORAGE', 'BACKUP_STORAGE'];
const VALID_CATEGORIES = ['none', 'local', 'database', 'object', 'cloud', 'network', 'archive', 'temporary', 'ai', 'translation', 'evidence', 'backup'];
const VALID_PROVIDERS = ['none', 'local', 'sqlite', 's3', 'azure', 'gcp', 'network', 'beestation', 'generic'];
const VALID_STORAGE_CLASSES = ['none', 'private', 'public', 'database', 'standard', 'infrequent_access', 'glacier', 'archive', 'temporary', 'evidence', 'backup'];
const BOOL_KEYS = ['requiresEncryption', 'requiresChecksum', 'requiresVirusScan', 'requiresAccessControl', 'requiresAudit', 'allowsPublicAccess', 'allowsExternalAccess', 'allowsTemporaryAccess', 'supportsVersioning', 'supportsRetentionLock', 'supportsLegalHold', 'supportsLifecycleTransition', 'supportsSignedUrl', 'supportsBackup'];
const RESERVED_KEYS = ['encryptionPolicy', 'checksumPolicy', 'virusScanPolicy', 'retentionPolicy', 'legalHoldPolicy', 'lifecyclePolicy', 'backupPolicy', 'signedUrlPolicy', 'replicationPolicy', 'integrationPolicy'];

const isNullOrNonNegInt = (v) => v === null || (Number.isInteger(v) && v >= 0);
const isNullOrPosInt = (v) => v === null || (Number.isInteger(v) && v > 0);

test('DS-1. registry has all expected modes with the full shape', () => {
  assert.deepEqual([...S.DOCUMENT_STORAGE_IDS].sort(), [...EXPECTED].sort());
  for (const id of S.DOCUMENT_STORAGE_IDS) {
    const s = S.DOCUMENT_STORAGE[id];
    assert.equal(s.id, id);
    assert.equal(typeof s.displayName, 'string');
    assert.equal(typeof s.description, 'string');
    assert.equal(typeof s.category, 'string');
    assert.equal(typeof s.provider, 'string');
    assert.equal(typeof s.storageClass, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof s[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof s.futureReserved, 'object');
  }
});

test('DS-2. unique ids, no duplicates', () => {
  assert.equal(S.DOCUMENT_STORAGE_IDS.length, new Set(S.DOCUMENT_STORAGE_IDS).size);
  assert.equal(S.DOCUMENT_STORAGE_IDS.length, EXPECTED.length);
});

test('DS-3. cross-validation: category/provider/storageClass valid; retention/size well-typed', () => {
  for (const id of S.DOCUMENT_STORAGE_IDS) {
    const s = S.DOCUMENT_STORAGE[id];
    assert.ok(VALID_CATEGORIES.includes(s.category), `${id} category valid`);
    assert.ok(VALID_PROVIDERS.includes(s.provider), `${id} provider valid`);
    assert.ok(VALID_STORAGE_CLASSES.includes(s.storageClass), `${id} storageClass valid`);
    assert.ok(isNullOrNonNegInt(s.defaultRetentionDays), `${id} defaultRetentionDays null|non-neg int`);
    assert.ok(isNullOrPosInt(s.maxFileSizeMb), `${id} maxFileSizeMb null|pos int`);
  }
});

test('DS-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of S.DOCUMENT_STORAGE_IDS) {
    const fr = S.DOCUMENT_STORAGE[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DS-5. deep frozen / immutable (registry, ids, each mode, futureReserved)', () => {
  assert.ok(Object.isFrozen(S.DOCUMENT_STORAGE) && Object.isFrozen(S.DOCUMENT_STORAGE_IDS));
  for (const id of S.DOCUMENT_STORAGE_IDS) {
    assert.ok(Object.isFrozen(S.DOCUMENT_STORAGE[id]));
    assert.ok(Object.isFrozen(S.DOCUMENT_STORAGE[id].futureReserved));
  }
  try { S.DOCUMENT_STORAGE.HACK = {}; } catch { /* ok */ }
  try { S.DOCUMENT_STORAGE.S3_STANDARD.requiresEncryption = false; } catch { /* ok */ }
  try { S.DOCUMENT_STORAGE.S3_STANDARD.futureReserved.encryptionPolicy = 'x'; } catch { /* ok */ }
  assert.equal(S.DOCUMENT_STORAGE.HACK, undefined);
  assert.equal(S.DOCUMENT_STORAGE.S3_STANDARD.requiresEncryption, true);
  assert.equal(S.DOCUMENT_STORAGE.S3_STANDARD.futureReserved.encryptionPolicy, null);
});

test('DS-6. getDocumentStorage: known + unknown → most-protective safe default (per spec)', () => {
  assert.equal(S.getDocumentStorage('S3_STANDARD').id, 'S3_STANDARD');
  const d = S.getDocumentStorage('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Storage');
  assert.equal(d.category, 'archive');
  assert.equal(d.provider, 'generic');
  assert.equal(d.storageClass, 'archive');
  const EXPECT = {
    requiresEncryption: true, requiresChecksum: true, requiresVirusScan: true, requiresAccessControl: true, requiresAudit: true,
    allowsPublicAccess: false, allowsExternalAccess: false, allowsTemporaryAccess: false,
    supportsVersioning: false, supportsRetentionLock: true, supportsLegalHold: true, supportsLifecycleTransition: false,
    supportsSignedUrl: false, supportsBackup: true,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  assert.equal(d.defaultRetentionDays, null);
  assert.equal(d.maxFileSizeMb, null);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(S.getDocumentStorage(bad).id, 'UNKNOWN');
});

test('DS-7. copy-on-read + mutation safety: registry never changes', () => {
  const c = S.getDocumentStorage('S3_STANDARD');
  c.requiresEncryption = false; c.maxFileSizeMb = 1; c.futureReserved.encryptionPolicy = 'y';
  const c2 = S.getDocumentStorage('S3_STANDARD');
  assert.equal(c2.requiresEncryption, true);
  assert.equal(c2.maxFileSizeMb, 5000);
  assert.equal(c2.futureReserved.encryptionPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DS-8. listDocumentStorage: fresh array + fresh objects; never exposes the registry', () => {
  const a = S.listDocumentStorage();
  const b = S.listDocumentStorage();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].futureReserved.encryptionPolicy = 'z';
  assert.equal(S.listDocumentStorage().length, EXPECTED.length);
  assert.notEqual(S.getDocumentStorage('NONE').id, 'mutated');
  for (const s of b) assert.notEqual(s, S.DOCUMENT_STORAGE[s.id], 'listed object is a copy');
});

test('DS-9. isKnownDocumentStorage: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(S.isKnownDocumentStorage('S3_STANDARD'), true);
  assert.equal(S.isKnownDocumentStorage('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(S.isKnownDocumentStorage(bad), false);
});

test('DS-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => S.getDocumentStorage(bad));
    assert.doesNotThrow(() => S.isKnownDocumentStorage(bad));
  }
  assert.doesNotThrow(() => S.listDocumentStorage());
});

test('DS-11. registry integrity: every flag varies; categories/providers/classes represented', () => {
  for (const k of BOOL_KEYS) {
    const vals = S.DOCUMENT_STORAGE_IDS.map((id) => S.DOCUMENT_STORAGE[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(S.DOCUMENT_STORAGE_IDS.map((id) => S.DOCUMENT_STORAGE[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  const provs = new Set(S.DOCUMENT_STORAGE_IDS.map((id) => S.DOCUMENT_STORAGE[id].provider));
  for (const p of VALID_PROVIDERS) assert.ok(provs.has(p), `provider ${p} represented`);
  const classes = new Set(S.DOCUMENT_STORAGE_IDS.map((id) => S.DOCUMENT_STORAGE[id].storageClass));
  for (const cl of VALID_STORAGE_CLASSES) assert.ok(classes.has(cl), `storageClass ${cl} represented`);
  for (const k of BOOL_KEYS) assert.equal(S.DOCUMENT_STORAGE.NONE[k], false, `NONE.${k} false`);
  assert.equal(S.DOCUMENT_STORAGE.LOCAL_PUBLIC.allowsPublicAccess, true);
  assert.equal(S.DOCUMENT_STORAGE.S3_GLACIER.supportsLegalHold, true);
});

test('DS-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(S).sort(), ['DOCUMENT_STORAGE', 'DOCUMENT_STORAGE_IDS', 'getDocumentStorage', 'isKnownDocumentStorage', 'listDocumentStorage'].sort());
});
