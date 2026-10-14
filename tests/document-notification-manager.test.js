// WP-18 · E14 — Enterprise Document Notification Engine Foundation tests.
// Exhaustively exercises the notification manager (create/deliverRecipient/failRecipient/
// acknowledgeRecipient/retryRecipient/cancelNotification/validate/normalize/clone/freeze/
// merge/compare/snapshot) and the notification history. Covers single + multi recipients,
// partial delivery, failure, retry, acknowledgement, cancel, priority, every derived state,
// hostile inputs, never-throw, determinism, immutability, copy-on-read, futureReserved,
// export surface, and unwired. Pure in-memory.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-notification-manager.js'));
const H = require(path.join(EDIR, 'document-notification-history.js'));
const DN = require(path.join(ROOT, 'lib', 'document', 'document-notifications.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const NT_FIELDS = ['notificationId', 'notificationType', 'status', 'channel', 'recipients', 'deliveredRecipients', 'failedRecipients', 'pendingRecipients', 'acknowledgedRecipients', 'requiresAcknowledgement', 'priority', 'attempts', 'comments', 'metadata', 'futureReserved'];
const HIGH_TYPE = DN.DOCUMENT_NOTIFICATION_IDS.find((id) => DN.getDocumentNotification(id).highPriority === true);
const LOW_TYPE = DN.DOCUMENT_NOTIFICATION_IDS.find((id) => DN.getDocumentNotification(id).highPriority !== true && DN.getDocumentNotification(id).defaultChannels.includes('app'));
const LOW_CHANNEL = DN.getDocumentNotification(LOW_TYPE).defaultChannels[0];

// ---------------------------------------------------------------------------
// manager: create
// ---------------------------------------------------------------------------

test('E14-1. createNotification: full structure, coercion, type/channel/priority/ack defaults', () => {
  const n = M.createNotification();
  assert.deepEqual(Object.keys(n), NT_FIELDS);
  assert.equal(n.status, 'PENDING');
  assert.equal(n.notificationType, 'NONE');
  assert.equal(n.attempts, 0);
  assert.equal(n.requiresAcknowledgement, DN.getDocumentNotification('NONE').requiresAcknowledgement);
  assert.deepEqual(n.pendingRecipients, []);
  const c = M.createNotification({ notificationType: HIGH_TYPE, status: 'QUEUED', channel: 'email', attempts: 2.9, comments: 5, requiresAcknowledgement: true, priority: 'urgent', metadata: [1], futureReserved: 'no', recipients: ['a', 'b'], deliveredRecipients: ['a'] });
  assert.equal(c.channel, 'email');
  assert.equal(c.attempts, 2);
  assert.equal(c.comments, '5');
  assert.equal(c.requiresAcknowledgement, true); // explicit override
  assert.equal(c.priority, 'urgent'); // explicit override
  assert.deepEqual(c.metadata, {});
  assert.deepEqual(c.pendingRecipients, ['b']);
  assert.equal(M.createNotification({ notificationType: HIGH_TYPE }).priority, 'high'); // from type.highPriority
  assert.equal(M.createNotification({ notificationType: LOW_TYPE }).priority, 'normal'); // from type (not high)
  assert.equal(M.createNotification({ notificationType: LOW_TYPE }).channel, DN.getDocumentNotification(LOW_TYPE).defaultChannels[0]); // default channel
  assert.equal(M.createNotification({}, { notificationType: HIGH_TYPE }).notificationType, HIGH_TYPE);
  assert.equal(M.createNotification({}, { defaultStatus: 'CANCELLED' }).status, 'CANCELLED');
});

// ---------------------------------------------------------------------------
// manager: recipient actions + derived states
// ---------------------------------------------------------------------------

test('E14-2. deliverRecipient: single delivers; partial; multi delivers; invalid', () => {
  const single = M.deliverRecipient(M.createNotification({ notificationType: LOW_TYPE }), 'alice', { comments: 'sent' });
  assert.equal(single.valid, true);
  assert.equal(single.notification.status, 'DELIVERED'); // auto-registered single, all delivered
  assert.deepEqual(single.notification.deliveredRecipients, ['alice']);
  assert.equal(single.notification.attempts, 1);
  assert.equal(single.notification.comments, 'sent');
  const d = M.createNotification({ recipients: ['a', 'b'] });
  const p = M.deliverRecipient(d, 'a');
  assert.equal(p.notification.status, 'PARTIALLY_DELIVERED');
  assert.deepEqual(p.notification.pendingRecipients, ['b']);
  assert.equal(M.deliverRecipient(p.notification, 'b').notification.status, 'DELIVERED');
  assert.ok(M.deliverRecipient(single.notification, 'alice').errors.some((e) => e.code === 'DUPLICATE_RECIPIENT'));
  assert.ok(M.deliverRecipient(d, '  ').errors.some((e) => e.code === 'INVALID_RECIPIENT'));
});

test('E14-3. failRecipient / retryRecipient: derived FAILED / QUEUED / PENDING states', () => {
  const one = M.createNotification({ recipients: ['x'] });
  const f = M.failRecipient(one, 'x');
  assert.equal(f.notification.status, 'FAILED');
  assert.equal(f.notification.attempts, 1);
  assert.ok(M.failRecipient(f.notification, 'x').errors.some((e) => e.code === 'DUPLICATE_RECIPIENT'));
  const two = M.createNotification({ recipients: ['a', 'b'] });
  assert.equal(M.failRecipient(two, 'a').notification.status, 'QUEUED'); // none delivered, one failed, one pending
  const retried = M.retryRecipient(f.notification, 'x');
  assert.equal(retried.notification.status, 'PENDING'); // back to all-pending
  assert.equal(retried.notification.attempts, 2);
  assert.ok(M.retryRecipient(one, 'x').errors.some((e) => e.code === 'NOT_FAILED'));
  // failing a delivered + acknowledged recipient clears both
  const del = M.deliverRecipient(two, 'a').notification;
  const ack = M.acknowledgeRecipient(del, 'a').notification;
  const refail = M.failRecipient(ack, 'a').notification;
  assert.deepEqual(refail.deliveredRecipients, []);
  assert.deepEqual(refail.acknowledgedRecipients, []);
});

test('E14-4. acknowledgeRecipient + ACKNOWLEDGED derived state', () => {
  const two = M.createNotification({ recipients: ['a', 'b'] });
  const delivered = M.deliverRecipient(M.deliverRecipient(two, 'a').notification, 'b').notification;
  assert.equal(delivered.status, 'DELIVERED');
  const ack1 = M.acknowledgeRecipient(delivered, 'a');
  assert.equal(ack1.notification.status, 'DELIVERED'); // not all acknowledged yet
  const ack2 = M.acknowledgeRecipient(ack1.notification, 'b');
  assert.equal(ack2.notification.status, 'ACKNOWLEDGED'); // all delivered + all acknowledged
  assert.deepEqual(ack2.notification.acknowledgedRecipients, ['a', 'b']);
  assert.ok(M.acknowledgeRecipient(delivered, 'ghost').errors.some((e) => e.code === 'NOT_DELIVERED'));
  assert.ok(M.acknowledgeRecipient(ack1.notification, 'a').errors.some((e) => e.code === 'DUPLICATE_ACKNOWLEDGEMENT'));
  assert.ok(M.acknowledgeRecipient(delivered, '  ').errors.some((e) => e.code === 'INVALID_RECIPIENT'));
});

test('E14-5. cancelNotification + cancelled blocks all actions', () => {
  const partial = M.deliverRecipient(M.createNotification({ recipients: ['a', 'b'] }), 'a').notification;
  const cancelled = M.cancelNotification(partial, { comments: 'stop' });
  assert.equal(cancelled.valid, true);
  assert.equal(cancelled.notification.status, 'CANCELLED');
  // cannot cancel a terminal notification (DELIVERED / FAILED / ACKNOWLEDGED / CANCELLED)
  assert.equal(M.cancelNotification(M.deliverRecipient(M.createNotification({ recipients: ['a'] }), 'a').notification).valid, false);
  assert.equal(M.cancelNotification(M.failRecipient(M.createNotification({ recipients: ['a'] }), 'a').notification).valid, false);
  assert.equal(M.cancelNotification(cancelled.notification).valid, false);
  // cancelled blocks every recipient action
  assert.ok(M.deliverRecipient(cancelled.notification, 'q').errors.some((e) => e.code === 'NOT_NOTIFIABLE'));
  assert.ok(M.failRecipient(cancelled.notification, 'q').errors.some((e) => e.code === 'NOT_NOTIFIABLE'));
  assert.ok(M.retryRecipient(cancelled.notification, 'q').errors.some((e) => e.code === 'NOT_NOTIFIABLE'));
  assert.ok(M.acknowledgeRecipient(cancelled.notification, 'q').errors.some((e) => e.code === 'NOT_NOTIFIABLE'));
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E14-6. validateNotification: shape, type, status, channel, recipient + ack consistency', () => {
  assert.equal(M.validateNotification({ notificationType: LOW_TYPE, status: 'PENDING', channel: LOW_CHANNEL, recipients: ['a', 'b'] }).valid, true);
  const nonObj = M.validateNotification(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_NOTIFICATION');
  const codes = (a) => M.validateNotification(a).errors.map((e) => e.code);
  const warns = (a) => M.validateNotification(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'PENDING', notificationType: 'MADEUP' }).includes('UNKNOWN_TYPE'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  assert.ok(warns({ status: 'PENDING', notificationType: LOW_TYPE, channel: 'carrier-pigeon' }).includes('INVALID_CHANNEL'));
  assert.equal(warns({ status: 'PENDING', notificationType: LOW_TYPE, channel: LOW_CHANNEL }).includes('INVALID_CHANNEL'), false); // valid channel
  assert.equal(M.validateNotification({ status: 'PENDING', notificationType: LOW_TYPE }).warnings.some((w) => w.code === 'INVALID_CHANNEL'), false); // channel absent
  assert.ok(codes({ status: 'PENDING', recipients: ['x', 'x'] }).includes('DUPLICATE_RECIPIENT'));
  assert.ok(warns({ status: 'PENDING', recipients: ['a'], deliveredRecipients: ['ghost'] }).includes('INCONSISTENT_RECIPIENT'));
  assert.ok(warns({ status: 'PENDING', recipients: ['a'], failedRecipients: ['ghost'] }).includes('INCONSISTENT_RECIPIENT'));
  assert.ok(warns({ status: 'PENDING', deliveredRecipients: ['a'], acknowledgedRecipients: ['b'] }).includes('INCONSISTENT_ACKNOWLEDGEMENT'));
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E14-7. normalizeNotification: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeNotification({ status: 'PENDING', comments: '  c  ', recipients: [' b ', 'a', 'a', ''], metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.comments, 'c');
  assert.deepEqual(n.recipients, ['a', 'b']);
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E14-8. mergeNotification: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeNotification({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeNotification({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeNotification({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeNotification({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeNotification({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeNotification({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeNotification({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeNotification({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeNotification({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeNotification({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeNotification(5, { a: 1 }), { a: 1 });
});

test('E14-9. compareNotification: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareNotification({ status: 'PENDING', comments: 'x', metadata: { a: 1 }, same: 1 }, { status: 'DELIVERED', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['comments']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareNotification(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareNotification({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareNotification({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E14-10. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, recipients: ['x'] };
  const frozen = M.freezeNotification(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.recipients));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneNotification(src).metadata, src.metadata);
  assert.deepEqual(M.cloneNotification(5), {});
  assert.deepEqual(M.freezeNotification(5), {});
  const s1 = M.generateNotificationSnapshot(src);
  assert.equal(s1.schema, 'enterprise-notification.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateNotificationSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.notification));
  assert.notEqual(s1.digest, M.generateNotificationSnapshot({ status: 'DELIVERED' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E14-11. createHistory + listNotifications: structure, coercion, notificationId variants', () => {
  const h = H.createHistory({ notificationId: 'N1', notificationType: HIGH_TYPE, notifications: [{ status: 'PENDING' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['notificationId', 'notificationType', 'notifications', 'metadata', 'futureReserved']);
  assert.equal(h.notificationId, 'N1');
  assert.equal(H.listNotifications(h).length, 1);
  assert.equal(H.createHistory({}).notificationId, null);
  assert.equal(H.createHistory({ notificationId: null }).notificationId, null);
  assert.equal(H.createHistory({ notificationId: 7 }).notificationId, 7);
  assert.equal(H.createHistory({}).notificationType, 'NONE');
  assert.deepEqual(H.createHistory({ notifications: 'no', metadata: 5, futureReserved: 9 }).notifications, []);
});

test('E14-12. append / replace / remove / find', () => {
  const h = H.createHistory({ notifications: [{ notificationId: 'e1', status: 'PENDING' }] });
  const app = H.appendNotification(h, { notificationId: 'e2', status: 'DELIVERED' });
  assert.equal(app.notifications.length, 2);
  assert.equal(h.notifications.length, 1);
  const rep = H.replaceNotification(app, 'e1', { notificationId: 'e1', status: 'CANCELLED' });
  assert.equal(rep.notifications.find((n) => n.status === 'CANCELLED') !== undefined, true);
  assert.equal(H.replaceNotification(app, 'none', { notificationId: 'x' }).notifications.some((n) => n.notificationId === 'x'), false);
  const rem = H.removeNotification(app, 'e1');
  assert.equal(rem.notifications.length, 1);
  assert.equal(H.removeNotification(app, null).notifications.length, 2);
  assert.equal(H.findNotification(app, 'e2').notificationId, 'e2');
  assert.equal(H.findNotification(app, 'nope'), null);
  assert.equal(H.findNotification(app, null), null);
});

test('E14-13. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ notifications: [{ notificationId: 'e1' }, { notificationId: 'e2' }, { notificationId: 'e3' }] });
  assert.equal(H.findLatest(h).notificationId, 'e3');
  assert.equal(H.findLatest({ notifications: [] }), null);
  assert.equal(H.findPrevious(h, 'e2').notificationId, 'e1');
  assert.equal(H.findPrevious(h, 'e1'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, 'e2').notificationId, 'e3');
  assert.equal(H.findNext(h, 'e3'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  const noId = H.createHistory({ notifications: [{ status: 'DELIVERED' }, { status: 'FAILED' }] });
  assert.equal(H.findNotification(noId, 'DELIVERED').status, 'DELIVERED');
});

test('E14-14. compareHistory / validateHistory: keys, duplicates, per-notification, nested deepEqual', () => {
  const a = H.createHistory({ notifications: [{ notificationId: 'e1' }, { notificationId: 'e2' }] });
  const b = H.createHistory({ notifications: [{ notificationId: 'e1', comments: 'edited' }, { notificationId: 'e3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['e3']);
  assert.deepEqual(d.removed, ['e2']);
  assert.deepEqual(d.modified, ['e1']);
  const same = { notificationId: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ notifications: [same, { notificationId: 'x', metadata: { a: 1 } }, { notificationId: 'y', recipients: ['p'] }, { notificationId: 'z', recipients: ['p'] }, { notificationId: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ notifications: [same, { notificationId: 'x', metadata: { b: 1 } }, { notificationId: 'y', recipients: ['p', 'q'] }, { notificationId: 'z', recipients: ['q'] }, { notificationId: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  assert.equal(H.validateHistory({ notifications: [{ status: 'PENDING', notificationId: 'e1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ notifications: 'no' }).errors.some((e) => e.code === 'INVALID_NOTIFICATIONS'));
  const dup = H.validateHistory({ notifications: [{ status: 'PENDING', notificationId: 'e1' }, { status: 'PENDING', notificationId: 'e1' }] });
  assert.deepEqual(dup.duplicateNotifications, ['e1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_NOTIFICATION'));
  const bubble = H.validateHistory({ notifications: [{ status: 'FOO', notificationId: 'e1', notificationType: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_TYPE'));
  assert.ok(H.validateHistory({ notifications: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E14-15. normalizeHistory / clone / freeze: normalized, immutable, caller-safe', () => {
  const h = { notificationId: 'N', notificationType: HIGH_TYPE, notifications: [{ status: 'PENDING', recipients: ['b', 'a'] }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(Object.keys(n), ['notificationId', 'notificationType', 'notifications', 'metadata', 'futureReserved']);
  assert.deepEqual(n.notifications[0].recipients, ['a', 'b']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.notifications) && Object.isFrozen(frozen.notifications[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).notifications, h.notifications);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E14-16. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['acknowledgeRecipient', 'cancelNotification', 'cloneNotification', 'compareNotification', 'createNotification', 'deliverRecipient', 'failRecipient', 'freezeNotification', 'generateNotificationSnapshot', 'mergeNotification', 'normalizeNotification', 'retryRecipient', 'validateNotification']);
  assert.deepEqual(Object.keys(H).sort(), ['appendNotification', 'cloneHistory', 'compareHistory', 'createHistory', 'findLatest', 'findNext', 'findNotification', 'findPrevious', 'freezeHistory', 'listNotifications', 'normalizeHistory', 'removeNotification', 'replaceNotification', 'validateHistory']);
});

test('E14-17. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { notifications: 5 }, { attempts: 'x' }];
  for (const a of hostile) {
    for (const fn of ['createNotification', 'validateNotification', 'normalizeNotification', 'cloneNotification', 'freezeNotification', 'generateNotificationSnapshot', 'cancelNotification']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    for (const fn of ['deliverRecipient', 'failRecipient', 'acknowledgeRecipient', 'retryRecipient']) noThrow(() => M[fn](a, a, a), `M.${fn}`);
    noThrow(() => M.mergeNotification(a, a, a), 'M.mergeNotification');
    noThrow(() => M.compareNotification(a, a), 'M.compareNotification');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listNotifications']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendNotification', 'removeNotification', 'findNotification', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceNotification(a, a, a), 'H.replaceNotification');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E14-18. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ notificationType: HIGH_TYPE, status: 'PENDING', recipients: Object.freeze(['a']), metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createNotification(input), 'create frozen');
  noThrow(() => M.deliverRecipient(input, 'b'), 'deliver frozen');
  noThrow(() => M.normalizeNotification(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
  assert.deepEqual(M.createNotification({ status: 'PENDING' }), M.createNotification({ status: 'PENDING' }));
  const a = M.createNotification({ status: 'PENDING' });
  const b = M.createNotification({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E14-19. notification modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-notification-manager.js', 'document-notification-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E14-20. notification engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
