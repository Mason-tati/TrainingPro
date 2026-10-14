// WP-17 · D10 — Document distribution registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const D = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-distribution.js'));

const EXPECTED = ['NONE', 'ALL_USERS', 'ALL_EMPLOYEES', 'ALL_CONTRACTORS', 'ROLE_BASED', 'DEPARTMENT_BASED', 'SITE_BASED', 'COMPANY_WIDE', 'PROJECT_TEAM', 'TRAINING_GROUP', 'COMPETENCY_GROUP', 'EQUIPMENT_GROUP', 'SHIFT_PANEL', 'SUPERVISORS', 'MANAGERS', 'HSEQ_TEAM', 'HR_TEAM', 'DOCUMENT_OWNERS', 'APPROVERS', 'EXTERNAL_PARTIES', 'PUBLIC_AUDIENCE', 'CONTROLLED_COPY_HOLDERS', 'EMERGENCY_BROADCAST'];
const VALID_CATEGORIES = ['none', 'all', 'employment', 'role', 'department', 'site', 'company', 'project', 'training', 'competency', 'equipment', 'shift', 'leadership', 'hseq', 'hr', 'owner', 'approval', 'external', 'public', 'controlled', 'emergency'];
const VALID_AUDIENCE_TYPES = ['none', 'user', 'employee', 'contractor', 'role', 'department', 'site', 'company', 'project', 'training_group', 'competency_group', 'equipment_group', 'shift_panel', 'team', 'external', 'public', 'controlled_copy'];
const VALID_CHANNELS = ['app', 'email', 'kiosk', 'qr', 'sms', 'print', 'download', 'api', 'public_link', 'controlled_copy', 'none'];
const BOOL_KEYS = ['requiresAuthentication', 'requiresReadAcknowledgement', 'requiresElectronicSignature', 'requiresCompetency', 'requiresRoleMatch', 'requiresDepartmentMatch', 'requiresSiteMatch', 'requiresActiveEmployment', 'allowsExternalRecipients', 'allowsPublicAccess', 'allowsAnonymousAccess', 'tracksDelivery', 'tracksRead', 'tracksAcknowledgement', 'tracksExpiry'];
const RESERVED_KEYS = ['audienceResolver', 'deliveryPolicy', 'notificationTemplate', 'escalationRule', 'acknowledgementPolicy', 'signaturePolicy', 'competencyRule', 'employmentRule', 'externalSharingRule', 'integrationHook'];

test('DD-1. registry has all expected modes with the full shape', () => {
  assert.deepEqual([...D.DOCUMENT_DISTRIBUTION_IDS].sort(), [...EXPECTED].sort());
  for (const id of D.DOCUMENT_DISTRIBUTION_IDS) {
    const d = D.DOCUMENT_DISTRIBUTION[id];
    assert.equal(d.id, id);
    assert.equal(typeof d.displayName, 'string');
    assert.equal(typeof d.description, 'string');
    assert.equal(typeof d.category, 'string');
    assert.equal(typeof d.audienceType, 'string');
    for (const k of BOOL_KEYS) assert.equal(typeof d[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof d.defaultChannel, 'string');
    assert.ok(Array.isArray(d.allowedChannels));
    assert.equal(typeof d.futureReserved, 'object');
  }
});

test('DD-2. unique ids, no duplicates', () => {
  assert.equal(D.DOCUMENT_DISTRIBUTION_IDS.length, new Set(D.DOCUMENT_DISTRIBUTION_IDS).size);
  assert.equal(D.DOCUMENT_DISTRIBUTION_IDS.length, EXPECTED.length);
});

test('DD-3. cross-validation: category, audienceType, defaultChannel, allowedChannels all valid', () => {
  for (const id of D.DOCUMENT_DISTRIBUTION_IDS) {
    const d = D.DOCUMENT_DISTRIBUTION[id];
    assert.ok(VALID_CATEGORIES.includes(d.category), `${id} category valid`);
    assert.ok(VALID_AUDIENCE_TYPES.includes(d.audienceType), `${id} audienceType valid`);
    assert.ok(VALID_CHANNELS.includes(d.defaultChannel), `${id} defaultChannel valid`);
    for (const c of d.allowedChannels) assert.ok(VALID_CHANNELS.includes(c), `${id} channel ${c} valid`);
  }
});

test('DD-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of D.DOCUMENT_DISTRIBUTION_IDS) {
    const fr = D.DOCUMENT_DISTRIBUTION[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DD-5. deep frozen / immutable (registry, ids, each mode, allowedChannels, futureReserved)', () => {
  assert.ok(Object.isFrozen(D.DOCUMENT_DISTRIBUTION) && Object.isFrozen(D.DOCUMENT_DISTRIBUTION_IDS));
  for (const id of D.DOCUMENT_DISTRIBUTION_IDS) {
    const d = D.DOCUMENT_DISTRIBUTION[id];
    assert.ok(Object.isFrozen(d) && Object.isFrozen(d.allowedChannels) && Object.isFrozen(d.futureReserved));
  }
  try { D.DOCUMENT_DISTRIBUTION.HACK = {}; } catch { /* ok */ }
  try { D.DOCUMENT_DISTRIBUTION.SITE_BASED.allowedChannels.push('X'); } catch { /* ok */ }
  try { D.DOCUMENT_DISTRIBUTION.SITE_BASED.requiresSiteMatch = false; } catch { /* ok */ }
  assert.equal(D.DOCUMENT_DISTRIBUTION.HACK, undefined);
  assert.deepEqual(D.DOCUMENT_DISTRIBUTION.SITE_BASED.allowedChannels, ['app', 'kiosk', 'qr']);
  assert.equal(D.DOCUMENT_DISTRIBUTION.SITE_BASED.requiresSiteMatch, true);
});

test('DD-6. getDocumentDistribution: known + unknown → safe default (exact spec)', () => {
  assert.equal(D.getDocumentDistribution('ROLE_BASED').id, 'ROLE_BASED');
  const d = D.getDocumentDistribution('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Distribution Mode');
  assert.equal(d.category, 'controlled');
  assert.equal(d.audienceType, 'controlled_copy');
  const EXPECT = {
    requiresAuthentication: true, requiresReadAcknowledgement: true, requiresElectronicSignature: false, requiresCompetency: false,
    requiresRoleMatch: false, requiresDepartmentMatch: false, requiresSiteMatch: false, requiresActiveEmployment: true,
    allowsExternalRecipients: false, allowsPublicAccess: false, allowsAnonymousAccess: false,
    tracksDelivery: true, tracksRead: true, tracksAcknowledgement: true, tracksExpiry: true,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  assert.equal(d.defaultChannel, 'app');
  assert.deepEqual(d.allowedChannels, []);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(D.getDocumentDistribution(bad).id, 'UNKNOWN');
});

test('DD-7. copy-on-read + mutation safety: fresh allowedChannels; registry never changes', () => {
  const c = D.getDocumentDistribution('SITE_BASED');
  c.allowedChannels.push('HACK'); c.requiresSiteMatch = false; c.futureReserved.deliveryPolicy = 'y';
  const c2 = D.getDocumentDistribution('SITE_BASED');
  assert.deepEqual(c2.allowedChannels, ['app', 'kiosk', 'qr']);
  assert.equal(c2.requiresSiteMatch, true);
  assert.equal(c2.futureReserved.deliveryPolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.allowedChannels, c2.allowedChannels, 'fresh channels array each call');
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DD-8. listDocumentDistribution: fresh array + fresh objects/arrays; never exposes registry', () => {
  const a = D.listDocumentDistribution();
  const b = D.listDocumentDistribution();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].allowedChannels.push('X'); a[0].futureReserved.deliveryPolicy = 'z';
  assert.equal(D.listDocumentDistribution().length, EXPECTED.length);
  assert.notEqual(D.getDocumentDistribution('NONE').id, 'mutated');
  for (const d of b) {
    assert.notEqual(d, D.DOCUMENT_DISTRIBUTION[d.id], 'listed object is a copy');
    assert.notEqual(d.allowedChannels, D.DOCUMENT_DISTRIBUTION[d.id].allowedChannels, 'listed channels array is a copy');
  }
});

test('DD-9. isKnownDocumentDistribution: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(D.isKnownDocumentDistribution('ROLE_BASED'), true);
  assert.equal(D.isKnownDocumentDistribution('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(D.isKnownDocumentDistribution(bad), false);
});

test('DD-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => D.getDocumentDistribution(bad));
    assert.doesNotThrow(() => D.isKnownDocumentDistribution(bad));
  }
  assert.doesNotThrow(() => D.listDocumentDistribution());
});

test('DD-11. registry integrity: every rule flag varies; all categories + audience types represented', () => {
  for (const k of BOOL_KEYS) {
    const vals = D.DOCUMENT_DISTRIBUTION_IDS.map((id) => D.DOCUMENT_DISTRIBUTION[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(D.DOCUMENT_DISTRIBUTION_IDS.map((id) => D.DOCUMENT_DISTRIBUTION[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  const auds = new Set(D.DOCUMENT_DISTRIBUTION_IDS.map((id) => D.DOCUMENT_DISTRIBUTION[id].audienceType));
  for (const a of VALID_AUDIENCE_TYPES) assert.ok(auds.has(a), `audienceType ${a} represented`);
  assert.equal(D.DOCUMENT_DISTRIBUTION.PUBLIC_AUDIENCE.allowsAnonymousAccess, true);
  assert.equal(D.DOCUMENT_DISTRIBUTION.CONTROLLED_COPY_HOLDERS.requiresElectronicSignature, true);
  for (const k of BOOL_KEYS) assert.equal(D.DOCUMENT_DISTRIBUTION.NONE[k], false, `NONE.${k} false`);
});

test('DD-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(D).sort(), ['DOCUMENT_DISTRIBUTION', 'DOCUMENT_DISTRIBUTION_IDS', 'getDocumentDistribution', 'isKnownDocumentDistribution', 'listDocumentDistribution'].sort());
});
