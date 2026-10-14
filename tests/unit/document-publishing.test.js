// WP-17 · D9 — Document publishing registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'lib', 'document', 'document-publishing.js'));
const { DOCUMENT_STATUS_IDS } = require(path.join(ROOT, 'lib', 'document', 'document-status.js'));

const EXPECTED = ['NONE', 'INTERNAL_ONLY', 'CONTROLLED_DOCUMENT', 'TRAINING_RELEASE', 'READ_ACKNOWLEDGEMENT', 'ELECTRONIC_SIGNOFF', 'SITE_RELEASE', 'COMPANY_RELEASE', 'MULTI_SITE_RELEASE', 'PUBLIC_EXPORT', 'PDF_EXPORT', 'WORD_EXPORT', 'POWERPOINT_EXPORT', 'TRANSLATED_RELEASE', 'SUPERSEDED_RELEASE', 'ARCHIVE_RELEASE', 'EMERGENCY_RELEASE'];
const VALID_CATEGORIES = ['none', 'internal', 'controlled', 'training', 'acknowledgement', 'signoff', 'site', 'company', 'multi_site', 'public', 'export', 'translation', 'superseded', 'archive', 'emergency'];
const VALID_FORMATS = ['html', 'pdf', 'docx', 'pptx', 'xlsx', 'json', 'zip', 'image', 'video', 'none'];
const VALID_CHANNELS = ['app', 'email', 'download', 'print', 'kiosk', 'qr', 'api', 'public_link', 'controlled_copy', 'archive', 'none'];
const BOOL_KEYS = ['requiresApproval', 'requiresPublishedStatus', 'requiresVersionLock', 'requiresReadAcknowledgement', 'requiresElectronicSignature', 'requiresControlledCopy', 'requiresWatermark', 'allowsDownload', 'allowsPrint', 'allowsEmail', 'allowsExternalSharing', 'allowsPublicAccess', 'tracksDistribution', 'tracksAcknowledgement', 'tracksExpiry'];
const RESERVED_KEYS = ['renderPolicy', 'exportPolicy', 'distributionPolicy', 'watermarkPolicy', 'accessPolicy', 'expiryPolicy', 'acknowledgementPolicy', 'signaturePolicy', 'translationPolicy', 'integrationPolicy'];

test('DP-1. registry has all expected modes with the full shape', () => {
  assert.deepEqual([...P.DOCUMENT_PUBLISHING_IDS].sort(), [...EXPECTED].sort());
  for (const id of P.DOCUMENT_PUBLISHING_IDS) {
    const p = P.DOCUMENT_PUBLISHING[id];
    assert.equal(p.id, id);
    assert.equal(typeof p.displayName, 'string');
    assert.equal(typeof p.description, 'string');
    assert.equal(typeof p.category, 'string');
    assert.ok(Array.isArray(p.allowedFormats) && Array.isArray(p.allowedChannels));
    for (const k of BOOL_KEYS) assert.equal(typeof p[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof p.defaultWatermark, 'string');
    assert.equal(typeof p.defaultStatusAfterPublish, 'string');
    assert.equal(typeof p.futureReserved, 'object');
  }
});

test('DP-2. unique ids, no duplicates', () => {
  assert.equal(P.DOCUMENT_PUBLISHING_IDS.length, new Set(P.DOCUMENT_PUBLISHING_IDS).size);
  assert.equal(P.DOCUMENT_PUBLISHING_IDS.length, EXPECTED.length);
});

test('DP-3. cross-validation: category, formats, channels, status all valid', () => {
  for (const id of P.DOCUMENT_PUBLISHING_IDS) {
    const p = P.DOCUMENT_PUBLISHING[id];
    assert.ok(VALID_CATEGORIES.includes(p.category), `${id} category valid`);
    for (const f of p.allowedFormats) assert.ok(VALID_FORMATS.includes(f), `${id} format ${f} valid`);
    for (const c of p.allowedChannels) assert.ok(VALID_CHANNELS.includes(c), `${id} channel ${c} valid`);
    assert.ok(DOCUMENT_STATUS_IDS.includes(p.defaultStatusAfterPublish), `${id} defaultStatusAfterPublish known`);
  }
});

test('DP-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of P.DOCUMENT_PUBLISHING_IDS) {
    const fr = P.DOCUMENT_PUBLISHING[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DP-5. deep frozen / immutable (registry, ids, each mode, arrays, futureReserved)', () => {
  assert.ok(Object.isFrozen(P.DOCUMENT_PUBLISHING) && Object.isFrozen(P.DOCUMENT_PUBLISHING_IDS));
  for (const id of P.DOCUMENT_PUBLISHING_IDS) {
    const p = P.DOCUMENT_PUBLISHING[id];
    assert.ok(Object.isFrozen(p) && Object.isFrozen(p.allowedFormats) && Object.isFrozen(p.allowedChannels) && Object.isFrozen(p.futureReserved));
  }
  try { P.DOCUMENT_PUBLISHING.HACK = {}; } catch { /* ok */ }
  try { P.DOCUMENT_PUBLISHING.PDF_EXPORT.allowedFormats.push('X'); } catch { /* ok */ }
  try { P.DOCUMENT_PUBLISHING.PDF_EXPORT.requiresApproval = false; } catch { /* ok */ }
  assert.equal(P.DOCUMENT_PUBLISHING.HACK, undefined);
  assert.deepEqual(P.DOCUMENT_PUBLISHING.PDF_EXPORT.allowedFormats, ['pdf']);
  assert.equal(P.DOCUMENT_PUBLISHING.PDF_EXPORT.requiresApproval, true);
});

test('DP-6. getDocumentPublishing: known + unknown → safe default (exact spec)', () => {
  assert.equal(P.getDocumentPublishing('PDF_EXPORT').id, 'PDF_EXPORT');
  const d = P.getDocumentPublishing('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Publishing Mode');
  assert.equal(d.category, 'controlled');
  assert.deepEqual(d.allowedFormats, []);
  assert.deepEqual(d.allowedChannels, []);
  const EXPECT = {
    requiresApproval: true, requiresPublishedStatus: true, requiresVersionLock: true, requiresReadAcknowledgement: false,
    requiresElectronicSignature: false, requiresControlledCopy: true, requiresWatermark: true,
    allowsDownload: false, allowsPrint: false, allowsEmail: false, allowsExternalSharing: false, allowsPublicAccess: false,
    tracksDistribution: true, tracksAcknowledgement: false, tracksExpiry: true,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  assert.equal(d.defaultWatermark, 'CONTROLLED');
  assert.equal(d.defaultStatusAfterPublish, 'PUBLISHED');
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(P.getDocumentPublishing(bad).id, 'UNKNOWN');
});

test('DP-7. copy-on-read + mutation safety: fresh arrays; registry never changes', () => {
  const c = P.getDocumentPublishing('CONTROLLED_DOCUMENT');
  c.allowedFormats.push('HACK'); c.allowedChannels.push('x'); c.requiresApproval = false; c.futureReserved.renderPolicy = 'y';
  const c2 = P.getDocumentPublishing('CONTROLLED_DOCUMENT');
  assert.deepEqual(c2.allowedFormats, ['html', 'pdf']);
  assert.deepEqual(c2.allowedChannels, ['app', 'controlled_copy']);
  assert.equal(c2.requiresApproval, true);
  assert.equal(c2.futureReserved.renderPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.allowedFormats, c2.allowedFormats, 'fresh formats array each call');
  assert.notEqual(c.allowedChannels, c2.allowedChannels, 'fresh channels array each call');
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DP-8. listDocumentPublishing: fresh array + fresh objects/arrays; never exposes registry', () => {
  const a = P.listDocumentPublishing();
  const b = P.listDocumentPublishing();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].allowedFormats.push('X'); a[0].futureReserved.renderPolicy = 'z';
  assert.equal(P.listDocumentPublishing().length, EXPECTED.length);
  assert.notEqual(P.getDocumentPublishing('NONE').id, 'mutated');
  for (const p of b) {
    assert.notEqual(p, P.DOCUMENT_PUBLISHING[p.id], 'listed object is a copy');
    assert.notEqual(p.allowedFormats, P.DOCUMENT_PUBLISHING[p.id].allowedFormats, 'listed formats array is a copy');
  }
});

test('DP-9. isKnownDocumentPublishing: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(P.isKnownDocumentPublishing('PDF_EXPORT'), true);
  assert.equal(P.isKnownDocumentPublishing('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(P.isKnownDocumentPublishing(bad), false);
});

test('DP-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => P.getDocumentPublishing(bad));
    assert.doesNotThrow(() => P.isKnownDocumentPublishing(bad));
  }
  assert.doesNotThrow(() => P.listDocumentPublishing());
});

test('DP-11. registry integrity: every rule flag varies; all categories represented', () => {
  for (const k of BOOL_KEYS) {
    const vals = P.DOCUMENT_PUBLISHING_IDS.map((id) => P.DOCUMENT_PUBLISHING[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const usedCats = new Set(P.DOCUMENT_PUBLISHING_IDS.map((id) => P.DOCUMENT_PUBLISHING[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(usedCats.has(c), `category ${c} is represented`);
  assert.equal(P.DOCUMENT_PUBLISHING.PUBLIC_EXPORT.allowsPublicAccess, true);
  assert.equal(P.DOCUMENT_PUBLISHING.CONTROLLED_DOCUMENT.requiresControlledCopy, true);
  assert.equal(P.DOCUMENT_PUBLISHING.SUPERSEDED_RELEASE.defaultStatusAfterPublish, 'SUPERSEDED');
  assert.equal(P.DOCUMENT_PUBLISHING.ARCHIVE_RELEASE.defaultStatusAfterPublish, 'ARCHIVED');
  for (const k of BOOL_KEYS) assert.equal(P.DOCUMENT_PUBLISHING.NONE[k], false, `NONE.${k} false`);
});

test('DP-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(P).sort(), ['DOCUMENT_PUBLISHING', 'DOCUMENT_PUBLISHING_IDS', 'getDocumentPublishing', 'isKnownDocumentPublishing', 'listDocumentPublishing'].sort());
});
