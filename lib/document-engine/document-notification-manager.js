// WP-18 · E14 — Document notification manager (Enterprise Document Engine).
//
// Evaluates notification generation, recipients, delivery, retries, acknowledgement, and
// completion entirely in memory. NOT an email/SMS/messaging/workflow engine and NOT
// persistence — it only decides which notification actions are valid and produces
// deterministic notification objects with a derived status. Type/channel-aware via the
// WP-17 notification registry (its only import). Deterministic, never throws, never mutates
// callers, deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentNotification, isKnownDocumentNotification } = require('../document/document-notifications');

const NOTIFICATION_STATES = ['PENDING', 'QUEUED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'ACKNOWLEDGED', 'CANCELLED', 'UNKNOWN'];
const STATE_SET = new Set(NOTIFICATION_STATES);
const CANCEL_BLOCKED = new Set(['DELIVERED', 'FAILED', 'ACKNOWLEDGED', 'CANCELLED']);

const NOTIFICATION_FIELDS = [
  ['notificationId', 'string'],
  ['notificationType', 'string'],
  ['status', 'string'],
  ['channel', 'string'],
  ['recipients', 'array'],
  ['deliveredRecipients', 'array'],
  ['failedRecipients', 'array'],
  ['pendingRecipients', 'array'],
  ['acknowledgedRecipients', 'array'],
  ['requiresAcknowledgement', 'bool'],
  ['priority', 'string'],
  ['attempts', 'int'],
  ['comments', 'string'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-notification.v1';

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function pickString(...args) { for (const a of args) if (typeof a === 'string' && a !== '') return a; return undefined; }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim() !== ''; }

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}
function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) { if (!hasOwn(b, k)) return false; if (!deepEqual(a[k], b[k])) return false; }
    return true;
  }
  return false;
}
function deepFreeze(value) {
  if (Array.isArray(value)) { value.forEach(deepFreeze); return Object.freeze(value); }
  if (isPlainObject(value)) { for (const k of Object.keys(value)) deepFreeze(value[k]); return Object.freeze(value); }
  return value;
}
function canon(x) { return (x !== null && typeof x === 'object') ? JSON.stringify(x) : `${typeof x}:${String(x)}`; }
function uniqDeep(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) { const k = canon(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}
function normalizeAny(v) {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return normalizeArray(v);
  if (isPlainObject(v)) return normalizeObject(v);
  return v;
}
function normalizeArray(arr) {
  const mapped = arr.map(normalizeAny).filter((x) => x !== '');
  return uniqDeep(mapped).map((x) => [canon(x), x]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((p) => p[1]);
}
function normalizeObject(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = normalizeAny(o[k]);
  return out;
}

function coerce(kind, val) {
  if (kind === 'string') return (val === undefined || val === null) ? '' : String(val);
  if (kind === 'int') { if (Number.isInteger(val)) return val; return (typeof val === 'number' && Number.isFinite(val)) ? Math.trunc(val) : 0; }
  if (kind === 'bool') return val === true;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

function uniqPush(arr, value) { return arr.includes(value) ? arr.slice() : arr.concat([value]); }
function without(arr, value) { return arr.filter((x) => x !== value); }
function applyMeta(next, opts) {
  if (typeof opts.comments === 'string') next.comments = opts.comments;
  return next;
}

// Derive pendingRecipients + status from the recipient partition (deterministic).
function settleStatus(recipients, delivered, failed, acknowledged) {
  const pending = recipients.filter((r) => !delivered.includes(r) && !failed.includes(r));
  const deliveredCount = recipients.filter((r) => delivered.includes(r)).length;
  const failCount = recipients.filter((r) => failed.includes(r)).length;
  let status;
  if (pending.length === 0 && failCount === 0) {
    status = recipients.every((r) => acknowledged.includes(r)) ? 'ACKNOWLEDGED' : 'DELIVERED';
  } else if (pending.length === 0 && deliveredCount === 0) status = 'FAILED';
  else if (deliveredCount > 0) status = 'PARTIALLY_DELIVERED';
  else if (failCount > 0) status = 'QUEUED';
  else status = 'PENDING';
  return { pending, status };
}
function settle(next) {
  const s = settleStatus(next.recipients, next.deliveredRecipients, next.failedRecipients, next.acknowledgedRecipients);
  next.pendingRecipients = s.pending;
  next.status = s.status;
  return next;
}

// ---- public ----

function createNotification(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const a = {};
  for (const [name, kind] of NOTIFICATION_FIELDS) a[name] = coerce(kind, src[name]);
  const typeId = pickString(src.notificationType, opts.notificationType, opts.defaultType);
  a.notificationType = (typeId === undefined) ? 'NONE' : typeId;
  const typeObj = getDocumentNotification(a.notificationType);
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  a.status = (statusId === undefined) ? 'PENDING' : statusId;
  const channelId = pickString(src.channel, opts.channel);
  a.channel = (channelId === undefined) ? typeObj.defaultChannels[0] : channelId;
  a.requiresAcknowledgement = hasOwn(src, 'requiresAcknowledgement') ? (src.requiresAcknowledgement === true) : typeObj.requiresAcknowledgement;
  const priorityId = pickString(src.priority, opts.priority);
  a.priority = (priorityId === undefined) ? (typeObj.highPriority ? 'high' : 'normal') : priorityId;
  a.pendingRecipients = a.recipients.filter((r) => !a.deliveredRecipients.includes(r) && !a.failedRecipients.includes(r));
  return a;
}

function cloneNotification(notification) { return deepClone(obj(notification)); }
function freezeNotification(notification) { return deepFreeze(deepClone(obj(notification))); }

function actionCheck(cur, recipient) {
  const errors = [];
  if (cur.status === 'CANCELLED') errors.push({ field: 'status', code: 'NOT_NOTIFIABLE', message: 'notification is cancelled' });
  if (!isNonEmptyString(recipient)) errors.push({ field: 'recipient', code: 'INVALID_RECIPIENT', message: 'recipient must be a non-empty string' });
  return errors;
}

function deliverRecipient(notification, recipient, options) {
  const opts = obj(options);
  const cur = createNotification(notification);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && cur.deliveredRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'DUPLICATE_RECIPIENT', message: `${recipient} already delivered` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], notification: cur };
  const next = cloneNotification(cur);
  next.recipients = uniqPush(next.recipients, recipient);
  next.deliveredRecipients = uniqPush(next.deliveredRecipients, recipient);
  next.failedRecipients = without(next.failedRecipients, recipient);
  next.attempts += 1;
  return { valid: true, errors: [], warnings: [], notification: applyMeta(settle(next), opts) };
}

function failRecipient(notification, recipient, options) {
  const opts = obj(options);
  const cur = createNotification(notification);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && cur.failedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'DUPLICATE_RECIPIENT', message: `${recipient} already failed` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], notification: cur };
  const next = cloneNotification(cur);
  next.recipients = uniqPush(next.recipients, recipient);
  next.failedRecipients = uniqPush(next.failedRecipients, recipient);
  next.deliveredRecipients = without(next.deliveredRecipients, recipient);
  next.acknowledgedRecipients = without(next.acknowledgedRecipients, recipient);
  next.attempts += 1;
  return { valid: true, errors: [], warnings: [], notification: applyMeta(settle(next), opts) };
}

function retryRecipient(notification, recipient, options) {
  const opts = obj(options);
  const cur = createNotification(notification);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && !cur.failedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'NOT_FAILED', message: `${recipient} is not a failed recipient` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], notification: cur };
  const next = cloneNotification(cur);
  next.failedRecipients = without(next.failedRecipients, recipient);
  next.attempts += 1;
  return { valid: true, errors: [], warnings: [], notification: applyMeta(settle(next), opts) };
}

function acknowledgeRecipient(notification, recipient, options) {
  const opts = obj(options);
  const cur = createNotification(notification);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && !cur.deliveredRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'NOT_DELIVERED', message: `${recipient} has not been delivered to` });
  else if (errors.length === 0 && cur.acknowledgedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'DUPLICATE_ACKNOWLEDGEMENT', message: `${recipient} already acknowledged` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], notification: cur };
  const next = cloneNotification(cur);
  next.acknowledgedRecipients = uniqPush(next.acknowledgedRecipients, recipient);
  return { valid: true, errors: [], warnings: [], notification: applyMeta(settle(next), opts) };
}

function cancelNotification(notification, options) {
  const opts = obj(options);
  const cur = createNotification(notification);
  if (CANCEL_BLOCKED.has(cur.status)) {
    return { valid: false, errors: [{ field: 'status', code: 'NOT_CANCELLABLE', message: `cannot cancel in status ${cur.status}` }], warnings: [], notification: cur };
  }
  const next = cloneNotification(cur);
  next.status = 'CANCELLED';
  next.pendingRecipients = next.recipients.filter((r) => !next.deliveredRecipients.includes(r) && !next.failedRecipients.includes(r));
  return { valid: true, errors: [], warnings: [], notification: applyMeta(next, opts) };
}

function validateNotification(notification) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(notification)) {
    result.errors.push({ field: null, code: 'INVALID_NOTIFICATION', message: 'notification must be a plain object' });
    result.valid = false;
    return result;
  }
  const typeId = (typeof notification.notificationType === 'string') ? notification.notificationType.trim() : '';
  const typeKnown = isKnownDocumentNotification(typeId);
  if (typeId !== '' && !typeKnown) result.warnings.push({ field: 'notificationType', code: 'UNKNOWN_TYPE', message: `unknown notification type: ${typeId}` });

  const status = (typeof notification.status === 'string') ? notification.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  if (typeKnown && typeof notification.channel === 'string' && notification.channel !== '') {
    const allowed = getDocumentNotification(typeId).defaultChannels;
    if (!allowed.includes(notification.channel)) {
      result.warnings.push({ field: 'channel', code: 'INVALID_CHANNEL', message: `channel ${notification.channel} is not a default channel for type ${typeId}` });
    }
  }
  if (Array.isArray(notification.recipients) && uniqDeep(notification.recipients).length !== notification.recipients.length) {
    result.errors.push({ field: 'recipients', code: 'DUPLICATE_RECIPIENT', message: 'recipients contains duplicates' });
  }
  const recipients = Array.isArray(notification.recipients) ? notification.recipients : [];
  for (const key of ['deliveredRecipients', 'failedRecipients']) {
    if (Array.isArray(notification[key]) && notification[key].some((r) => !recipients.includes(r))) {
      result.warnings.push({ field: key, code: 'INCONSISTENT_RECIPIENT', message: `${key} contains a recipient not in recipients` });
    }
  }
  if (Array.isArray(notification.acknowledgedRecipients) && Array.isArray(notification.deliveredRecipients)
      && notification.acknowledgedRecipients.some((r) => !notification.deliveredRecipients.includes(r))) {
    result.warnings.push({ field: 'acknowledgedRecipients', code: 'INCONSISTENT_ACKNOWLEDGEMENT', message: 'an acknowledged recipient has not been delivered to' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeNotification(notification) {
  const n = createNotification(notification);
  for (const [name, kind] of NOTIFICATION_FIELDS) {
    if (kind === 'string' && typeof n[name] === 'string') n[name] = n[name].trim();
    else if (kind === 'object') n[name] = normalizeObject(n[name]);
    else if (kind === 'array') n[name] = normalizeArray(n[name]);
  }
  return n;
}

function mergeNotification(base, incoming, options) {
  const opts = obj(options);
  const strategy = (opts.strategy === 'keepExisting') ? 'keepExisting' : 'overwrite';
  const arrays = opts.arrays || 'replace';
  const objects = opts.objects || 'replace';
  const out = deepClone(obj(base));
  const inc = deepClone(obj(incoming));
  for (const key of Object.keys(inc)) {
    const iv = inc[key];
    if (!hasOwn(out, key)) { out[key] = iv; continue; }
    const bv = out[key];
    if (Array.isArray(bv) && Array.isArray(iv)) {
      if (arrays === 'append') out[key] = bv.concat(iv);
      else if (arrays === 'union') out[key] = uniqDeep(bv.concat(iv));
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else if (isPlainObject(bv) && isPlainObject(iv)) {
      if (objects === 'merge') out[key] = mergeNotification(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareNotification(a, b) {
  const A = obj(a);
  const B = obj(b);
  const keys = new Set([...Object.keys(A), ...Object.keys(B)]);
  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];
  for (const k of keys) {
    const inA = hasOwn(A, k);
    const inB = hasOwn(B, k);
    if (inA && !inB) removed.push(k);
    else if (!inA && inB) added.push(k);
    else if (deepEqual(A[k], B[k])) unchanged.push(k);
    else modified.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), unchanged: unchanged.sort() };
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (`0000000${h.toString(16)}`).slice(-8);
}

function generateNotificationSnapshot(notification) {
  const normalized = normalizeNotification(notification);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), notification: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createNotification,
  deliverRecipient,
  failRecipient,
  acknowledgeRecipient,
  retryRecipient,
  cancelNotification,
  validateNotification,
  normalizeNotification,
  cloneNotification,
  freezeNotification,
  mergeNotification,
  compareNotification,
  generateNotificationSnapshot,
};
