// WP-18 · E14 — Document notification history (Enterprise Document Engine).
//
// An ordered, in-memory log of notification events: append/replace/remove, find (by key /
// latest / previous / next), list, compare, validate, normalize, clone, freeze. Delegates
// per-notification work to the sibling notification manager. Deterministic, never throws,
// never mutates caller objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-notification-manager');

const HISTORY_FIELDS = ['notificationId', 'notificationType', 'notifications', 'metadata', 'futureReserved'];

function isPlainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }
function obj(v) { return isPlainObject(v) ? v : {}; }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
function pickString(...args) { for (const a of args) if (typeof a === 'string' && a !== '') return a; return undefined; }

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

// A stable key for a notification event: notificationId, else status, else notificationType.
function notificationKey(n) {
  const s = obj(n);
  const key = pickString(s.notificationId, s.status, s.notificationType);
  return (key === undefined) ? '' : key;
}

// Order by insertion (stable): notification events have no timestamp field.
function orderNotifications(h) {
  return h.notifications
    .map((n, i) => [n, i])
    .sort((a, b) => (a[1] - b[1]))
    .map((p) => p[0]);
}

function normalizeList(list) {
  return (Array.isArray(list) ? list : []).map((n) => manager.createNotification(n));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    notificationId: (typeof src.notificationId === 'string') ? src.notificationId : ((src.notificationId === undefined || src.notificationId === null) ? null : src.notificationId),
    notificationType: (typeof src.notificationType === 'string' && src.notificationType !== '') ? src.notificationType : 'NONE',
    notifications: normalizeList(src.notifications),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listNotifications(history) { return createHistory(history).notifications; }

function appendNotification(history, notification) {
  const h = createHistory(history);
  h.notifications = h.notifications.concat([manager.createNotification(notification)]);
  return h;
}

function replaceNotification(history, key, notification) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createNotification(notification);
  h.notifications = h.notifications.map((n) => (notificationKey(n) === target ? replacement : n));
  return h;
}

function removeNotification(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.notifications = h.notifications.filter((n) => notificationKey(n) !== target);
  return h;
}

function findNotification(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.notifications.find((n) => notificationKey(n) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.notifications.length === 0) return null;
  const sorted = orderNotifications(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderNotifications(h);
  const idx = sorted.findIndex((n) => notificationKey(n) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderNotifications(h);
  const idx = sorted.findIndex((n) => notificationKey(n) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const n of ha.notifications) mapA.set(notificationKey(n), n);
  for (const n of hb.notifications) mapB.set(notificationKey(n), n);
  const keys = new Set([...mapA.keys(), ...mapB.keys()]);
  const added = [];
  const removed = [];
  const modified = [];
  const unchanged = [];
  for (const k of keys) {
    const inA = mapA.has(k);
    const inB = mapB.has(k);
    if (inA && !inB) removed.push(k);
    else if (!inA && inB) added.push(k);
    else if (deepEqual(mapA.get(k), mapB.get(k))) unchanged.push(k);
    else modified.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), unchanged: unchanged.sort() };
}

function validateHistory(history) {
  const result = { valid: true, errors: [], warnings: [], duplicateNotifications: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const notifications = Array.isArray(history.notifications) ? history.notifications : [];
  if (!Array.isArray(history.notifications)) {
    result.errors.push({ field: 'notifications', code: 'INVALID_NOTIFICATIONS', message: 'notifications must be an array' });
  }
  const present = new Set();
  for (const n of notifications) {
    const key = notificationKey(n);
    if (present.has(key)) { if (!result.duplicateNotifications.includes(key)) result.duplicateNotifications.push(key); }
    present.add(key);
    const vv = manager.validateNotification(n);
    for (const e of vv.errors) result.errors.push({ field: `notifications[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `notifications[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateNotifications.length > 0) {
    result.errors.push({ field: 'notifications', code: 'DUPLICATE_NOTIFICATION', message: `duplicate notifications: ${result.duplicateNotifications.join(', ')}` });
  }
  result.duplicateNotifications.sort();
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeMeta(m) {
  const out = {};
  for (const k of Object.keys(obj(m)).sort()) { const v = m[k]; out[k] = (typeof v === 'string') ? v.trim() : deepClone(v); }
  return out;
}

function normalizeHistory(history) {
  const h = createHistory(history);
  const built = {
    notificationId: h.notificationId,
    notificationType: h.notificationType,
    notifications: h.notifications.map((n) => manager.normalizeNotification(n)),
    metadata: normalizeMeta(h.metadata),
    futureReserved: deepClone(h.futureReserved),
  };
  const out = {};
  for (const name of HISTORY_FIELDS) out[name] = built[name];
  return out;
}

function cloneHistory(history) { return deepClone(obj(history)); }
function freezeHistory(history) { return deepFreeze(deepClone(obj(history))); }

module.exports = {
  createHistory,
  appendNotification,
  replaceNotification,
  removeNotification,
  findNotification,
  findLatest,
  findPrevious,
  findNext,
  listNotifications,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
