// WP-17 · D13 — Document notification registry tests (immutable, cross-checked, 100% cov).
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const N = require(path.join(__dirname, '..', '..', 'lib', 'document', 'document-notifications.js'));

const EXPECTED = ['NONE', 'DOCUMENT_CREATED', 'DOCUMENT_UPDATED', 'DOCUMENT_SUBMITTED_FOR_REVIEW', 'DOCUMENT_REVIEW_ASSIGNED', 'DOCUMENT_REVIEW_DUE', 'DOCUMENT_REVIEW_OVERDUE', 'DOCUMENT_APPROVAL_REQUESTED', 'DOCUMENT_APPROVAL_APPROVED', 'DOCUMENT_APPROVAL_REJECTED', 'DOCUMENT_PUBLISHED', 'DOCUMENT_SUPERSEDED', 'DOCUMENT_ARCHIVED', 'DOCUMENT_EXPIRING_SOON', 'DOCUMENT_EXPIRED', 'READ_ACKNOWLEDGEMENT_REQUIRED', 'READ_ACKNOWLEDGEMENT_OVERDUE', 'ELECTRONIC_SIGNATURE_REQUIRED', 'ELECTRONIC_SIGNATURE_OVERDUE', 'TRAINING_RELEASED', 'TRAINING_ACKNOWLEDGEMENT_REQUIRED', 'TRANSLATION_READY', 'AI_CONTENT_REVIEW_REQUIRED', 'CONTROLLED_COPY_DISTRIBUTED', 'EMERGENCY_DOCUMENT_RELEASED'];
const VALID_CATEGORIES = ['none', 'lifecycle', 'review', 'approval', 'publishing', 'expiry', 'acknowledgement', 'signature', 'training', 'translation', 'ai', 'controlled_copy', 'emergency'];
const VALID_TRIGGERS = ['none', 'create', 'update', 'submit_review', 'assign_review', 'due_review', 'overdue_review', 'request_approval', 'approve', 'reject', 'publish', 'supersede', 'archive', 'expiry_warning', 'expired', 'read_ack_required', 'read_ack_overdue', 'signature_required', 'signature_overdue', 'training_release', 'translation_ready', 'ai_review_required', 'controlled_copy_distributed', 'emergency_release'];
const VALID_CHANNELS = ['app', 'email', 'sms', 'kiosk', 'teams', 'slack', 'webhook', 'none'];
const VALID_RECIPIENT_TYPES = ['none', 'actor', 'owner', 'author', 'reviewer', 'approver', 'publisher', 'document_control', 'training_group', 'readers', 'acknowledgers', 'signers', 'supervisors', 'managers', 'hseq', 'hr', 'external', 'admins'];
const BOOL_KEYS = ['requiresAuthentication', 'requiresAcknowledgement', 'requiresEscalation', 'allowsDigest', 'allowsBatching', 'allowsExternalRecipients', 'highPriority', 'auditRequired'];
const RESERVED_KEYS = ['templatePolicy', 'deliveryPolicy', 'digestPolicy', 'batchingPolicy', 'escalationPolicy', 'reminderPolicy', 'localizationPolicy', 'integrationPolicy', 'preferencePolicy', 'suppressionPolicy'];

const isNullOrNonNegInt = (v) => v === null || (Number.isInteger(v) && v >= 0);

test('DN-1. registry has all expected notifications with the full shape', () => {
  assert.deepEqual([...N.DOCUMENT_NOTIFICATION_IDS].sort(), [...EXPECTED].sort());
  for (const id of N.DOCUMENT_NOTIFICATION_IDS) {
    const n = N.DOCUMENT_NOTIFICATIONS[id];
    assert.equal(n.id, id);
    assert.equal(typeof n.displayName, 'string');
    assert.equal(typeof n.description, 'string');
    assert.equal(typeof n.category, 'string');
    assert.equal(typeof n.trigger, 'string');
    assert.ok(Array.isArray(n.defaultChannels) && Array.isArray(n.recipientTypes));
    for (const k of BOOL_KEYS) assert.equal(typeof n[k], 'boolean', `${id}.${k} boolean`);
    assert.equal(typeof n.futureReserved, 'object');
  }
});

test('DN-2. unique ids, no duplicates', () => {
  assert.equal(N.DOCUMENT_NOTIFICATION_IDS.length, new Set(N.DOCUMENT_NOTIFICATION_IDS).size);
  assert.equal(N.DOCUMENT_NOTIFICATION_IDS.length, EXPECTED.length);
});

test('DN-3. cross-validation: category/trigger/channels/recipients valid; reminder/escalation well-typed', () => {
  for (const id of N.DOCUMENT_NOTIFICATION_IDS) {
    const n = N.DOCUMENT_NOTIFICATIONS[id];
    assert.ok(VALID_CATEGORIES.includes(n.category), `${id} category valid`);
    assert.ok(VALID_TRIGGERS.includes(n.trigger), `${id} trigger valid`);
    for (const c of n.defaultChannels) assert.ok(VALID_CHANNELS.includes(c), `${id} channel ${c} valid`);
    for (const r of n.recipientTypes) assert.ok(VALID_RECIPIENT_TYPES.includes(r), `${id} recipient ${r} valid`);
    assert.ok(isNullOrNonNegInt(n.defaultReminderDays), `${id} defaultReminderDays null|non-neg int`);
    assert.ok(isNullOrNonNegInt(n.defaultEscalationDays), `${id} defaultEscalationDays null|non-neg int`);
  }
});

test('DN-4. futureReserved: exactly the reserved keys, all null', () => {
  for (const id of N.DOCUMENT_NOTIFICATION_IDS) {
    const fr = N.DOCUMENT_NOTIFICATIONS[id].futureReserved;
    assert.deepEqual(Object.keys(fr).sort(), [...RESERVED_KEYS].sort(), `${id} reserved keys`);
    for (const k of RESERVED_KEYS) assert.equal(fr[k], null, `${id}.futureReserved.${k} null`);
  }
});

test('DN-5. deep frozen / immutable (registry, ids, each notif, arrays, futureReserved)', () => {
  assert.ok(Object.isFrozen(N.DOCUMENT_NOTIFICATIONS) && Object.isFrozen(N.DOCUMENT_NOTIFICATION_IDS));
  for (const id of N.DOCUMENT_NOTIFICATION_IDS) {
    const n = N.DOCUMENT_NOTIFICATIONS[id];
    assert.ok(Object.isFrozen(n) && Object.isFrozen(n.defaultChannels) && Object.isFrozen(n.recipientTypes) && Object.isFrozen(n.futureReserved));
  }
  try { N.DOCUMENT_NOTIFICATIONS.HACK = {}; } catch { /* ok */ }
  try { N.DOCUMENT_NOTIFICATIONS.DOCUMENT_PUBLISHED.defaultChannels.push('X'); } catch { /* ok */ }
  try { N.DOCUMENT_NOTIFICATIONS.DOCUMENT_PUBLISHED.highPriority = true; } catch { /* ok */ }
  assert.equal(N.DOCUMENT_NOTIFICATIONS.HACK, undefined);
  assert.deepEqual(N.DOCUMENT_NOTIFICATIONS.DOCUMENT_PUBLISHED.defaultChannels, ['app', 'email', 'kiosk']);
  assert.equal(N.DOCUMENT_NOTIFICATIONS.DOCUMENT_PUBLISHED.highPriority, false);
});

test('DN-6. getDocumentNotification: known + unknown → safe default (exact spec)', () => {
  assert.equal(N.getDocumentNotification('DOCUMENT_PUBLISHED').id, 'DOCUMENT_PUBLISHED');
  const d = N.getDocumentNotification('NOPE');
  assert.equal(d.id, 'UNKNOWN');
  assert.equal(d.displayName, 'Unknown Notification');
  assert.equal(d.category, 'lifecycle');
  assert.equal(d.trigger, 'none');
  assert.deepEqual(d.defaultChannels, []);
  assert.deepEqual(d.recipientTypes, []);
  const EXPECT = {
    requiresAuthentication: true, requiresAcknowledgement: false, requiresEscalation: false,
    allowsDigest: false, allowsBatching: false, allowsExternalRecipients: false, highPriority: false, auditRequired: true,
  };
  for (const k of BOOL_KEYS) assert.equal(d[k], EXPECT[k], `UNKNOWN.${k}`);
  assert.equal(d.defaultReminderDays, null);
  assert.equal(d.defaultEscalationDays, null);
  for (const k of RESERVED_KEYS) assert.equal(d.futureReserved[k], null);
  for (const bad of [null, undefined, 5, {}, [], Symbol('x')]) assert.equal(N.getDocumentNotification(bad).id, 'UNKNOWN');
});

test('DN-7. copy-on-read + mutation safety: fresh arrays; registry never changes', () => {
  const c = N.getDocumentNotification('DOCUMENT_REVIEW_OVERDUE');
  c.defaultChannels.push('HACK'); c.recipientTypes.push('x'); c.requiresEscalation = false; c.futureReserved.templatePolicy = 'y';
  const c2 = N.getDocumentNotification('DOCUMENT_REVIEW_OVERDUE');
  assert.deepEqual(c2.defaultChannels, ['app', 'email', 'sms']);
  assert.deepEqual(c2.recipientTypes, ['reviewer', 'managers']);
  assert.equal(c2.requiresEscalation, true);
  assert.equal(c2.futureReserved.templatePolicy, null);
  assert.notEqual(c, c2);
  assert.notEqual(c.defaultChannels, c2.defaultChannels, 'fresh channels array each call');
  assert.notEqual(c.recipientTypes, c2.recipientTypes, 'fresh recipients array each call');
  assert.notEqual(c.futureReserved, c2.futureReserved);
});

test('DN-8. listDocumentNotifications: fresh array + fresh objects/arrays; never exposes registry', () => {
  const a = N.listDocumentNotifications();
  const b = N.listDocumentNotifications();
  assert.notEqual(a, b);
  assert.equal(a.length, EXPECTED.length);
  a.pop(); a[0].id = 'mutated'; a[0].defaultChannels.push('X'); a[0].futureReserved.templatePolicy = 'z';
  assert.equal(N.listDocumentNotifications().length, EXPECTED.length);
  assert.notEqual(N.getDocumentNotification('NONE').id, 'mutated');
  for (const n of b) {
    assert.notEqual(n, N.DOCUMENT_NOTIFICATIONS[n.id], 'listed object is a copy');
    assert.notEqual(n.defaultChannels, N.DOCUMENT_NOTIFICATIONS[n.id].defaultChannels, 'listed channels array is a copy');
  }
});

test('DN-9. isKnownDocumentNotification: boolean; true for known, false for unknown/garbage', () => {
  assert.equal(N.isKnownDocumentNotification('DOCUMENT_PUBLISHED'), true);
  assert.equal(N.isKnownDocumentNotification('UNKNOWN'), false, 'UNKNOWN safe default is not registered');
  for (const bad of ['NOPE', '', null, undefined, 5, {}, [], Symbol('x')]) assert.equal(N.isKnownDocumentNotification(bad), false);
});

test('DN-10. never throws for any input', () => {
  for (const bad of [undefined, null, {}, [], 5, 'x', Symbol('s'), () => {}, true, 10n]) {
    assert.doesNotThrow(() => N.getDocumentNotification(bad));
    assert.doesNotThrow(() => N.isKnownDocumentNotification(bad));
  }
  assert.doesNotThrow(() => N.listDocumentNotifications());
});

test('DN-11. registry integrity: every boolean varies; all categories + triggers represented', () => {
  for (const k of BOOL_KEYS) {
    const vals = N.DOCUMENT_NOTIFICATION_IDS.map((id) => N.DOCUMENT_NOTIFICATIONS[id][k]);
    assert.ok(vals.includes(true), `${k} true somewhere`);
    assert.ok(vals.includes(false), `${k} false somewhere`);
  }
  const cats = new Set(N.DOCUMENT_NOTIFICATION_IDS.map((id) => N.DOCUMENT_NOTIFICATIONS[id].category));
  for (const c of VALID_CATEGORIES) assert.ok(cats.has(c), `category ${c} represented`);
  const trigs = new Set(N.DOCUMENT_NOTIFICATION_IDS.map((id) => N.DOCUMENT_NOTIFICATIONS[id].trigger));
  for (const t of VALID_TRIGGERS) assert.ok(trigs.has(t), `trigger ${t} represented`);
  for (const k of BOOL_KEYS) assert.equal(N.DOCUMENT_NOTIFICATIONS.NONE[k], false, `NONE.${k} false`);
  assert.equal(N.DOCUMENT_NOTIFICATIONS.DOCUMENT_REVIEW_OVERDUE.highPriority, true);
  assert.equal(N.DOCUMENT_NOTIFICATIONS.DOCUMENT_REVIEW_DUE.defaultReminderDays, 3);
  assert.equal(N.DOCUMENT_NOTIFICATIONS.DOCUMENT_EXPIRED.defaultEscalationDays, 1);
});

test('DN-12. exports exactly the required surface', () => {
  assert.deepEqual(Object.keys(N).sort(), ['DOCUMENT_NOTIFICATIONS', 'DOCUMENT_NOTIFICATION_IDS', 'getDocumentNotification', 'isKnownDocumentNotification', 'listDocumentNotifications'].sort());
});
