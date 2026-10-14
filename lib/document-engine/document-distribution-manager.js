// WP-18 · E13 — Document distribution manager (Enterprise Document Engine).
//
// Evaluates distribution recipients, delivery, retries, acknowledgement, and completion
// entirely in memory. NOT a notification/access-control/publishing engine and NOT
// persistence — it only decides which distribution actions are valid and produces
// deterministic distribution objects. Mode/channel-aware via the WP-17 distribution
// registry (its only import). Deterministic, never throws, never mutates callers,
// deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentDistribution, isKnownDocumentDistribution } = require('../document/document-distribution');

const DISTRIBUTION_STATES = ['PENDING', 'IN_PROGRESS', 'PARTIALLY_COMPLETED', 'COMPLETED', 'FAILED', 'CANCELLED', 'UNKNOWN'];
const STATE_SET = new Set(DISTRIBUTION_STATES);

const DISTRIBUTION_FIELDS = [
  ['distributionId', 'string'],
  ['mode', 'string'],
  ['status', 'string'],
  ['channel', 'string'],
  ['recipients', 'array'],
  ['completedRecipients', 'array'],
  ['failedRecipients', 'array'],
  ['pendingRecipients', 'array'],
  ['requiresAcknowledgement', 'bool'],
  ['acknowledgedRecipients', 'array'],
  ['deliveryAttempts', 'int'],
  ['comments', 'string'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-distribution.v1';

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
function settleStatus(recipients, completed, failed) {
  const pending = recipients.filter((r) => !completed.includes(r) && !failed.includes(r));
  const doneCount = recipients.filter((r) => completed.includes(r)).length;
  const failCount = recipients.filter((r) => failed.includes(r)).length;
  let status;
  if (pending.length === 0 && failCount === 0) status = 'COMPLETED';
  else if (pending.length === 0 && doneCount === 0) status = 'FAILED';
  else if (doneCount > 0) status = 'PARTIALLY_COMPLETED';
  else if (failCount > 0) status = 'IN_PROGRESS';
  else status = 'PENDING';
  return { pending, status };
}
function settle(next) {
  const s = settleStatus(next.recipients, next.completedRecipients, next.failedRecipients);
  next.pendingRecipients = s.pending;
  next.status = s.status;
  return next;
}

// ---- public ----

function createDistribution(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const a = {};
  for (const [name, kind] of DISTRIBUTION_FIELDS) a[name] = coerce(kind, src[name]);
  const modeId = pickString(src.mode, opts.mode, opts.defaultMode);
  a.mode = (modeId === undefined) ? 'NONE' : modeId;
  const modeObj = getDocumentDistribution(a.mode);
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  a.status = (statusId === undefined) ? 'PENDING' : statusId;
  const channelId = pickString(src.channel, opts.channel);
  a.channel = (channelId === undefined) ? modeObj.defaultChannel : channelId;
  a.requiresAcknowledgement = hasOwn(src, 'requiresAcknowledgement') ? (src.requiresAcknowledgement === true) : modeObj.requiresReadAcknowledgement;
  a.pendingRecipients = a.recipients.filter((r) => !a.completedRecipients.includes(r) && !a.failedRecipients.includes(r));
  return a;
}

function cloneDistribution(distribution) { return deepClone(obj(distribution)); }
function freezeDistribution(distribution) { return deepFreeze(deepClone(obj(distribution))); }

function actionCheck(cur, recipient) {
  const errors = [];
  if (cur.status === 'CANCELLED') errors.push({ field: 'status', code: 'NOT_DISTRIBUTABLE', message: 'distribution is cancelled' });
  if (!isNonEmptyString(recipient)) errors.push({ field: 'recipient', code: 'INVALID_RECIPIENT', message: 'recipient must be a non-empty string' });
  return errors;
}

function completeRecipient(distribution, recipient, options) {
  const opts = obj(options);
  const cur = createDistribution(distribution);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && cur.completedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'DUPLICATE_RECIPIENT', message: `${recipient} already completed` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], distribution: cur };
  const next = cloneDistribution(cur);
  next.recipients = uniqPush(next.recipients, recipient);
  next.completedRecipients = uniqPush(next.completedRecipients, recipient);
  next.failedRecipients = without(next.failedRecipients, recipient);
  next.deliveryAttempts += 1;
  return { valid: true, errors: [], warnings: [], distribution: applyMeta(settle(next), opts) };
}

function failRecipient(distribution, recipient, options) {
  const opts = obj(options);
  const cur = createDistribution(distribution);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && cur.failedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'DUPLICATE_RECIPIENT', message: `${recipient} already failed` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], distribution: cur };
  const next = cloneDistribution(cur);
  next.recipients = uniqPush(next.recipients, recipient);
  next.failedRecipients = uniqPush(next.failedRecipients, recipient);
  next.completedRecipients = without(next.completedRecipients, recipient);
  next.deliveryAttempts += 1;
  return { valid: true, errors: [], warnings: [], distribution: applyMeta(settle(next), opts) };
}

function retryRecipient(distribution, recipient, options) {
  const opts = obj(options);
  const cur = createDistribution(distribution);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && !cur.failedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'NOT_FAILED', message: `${recipient} is not a failed recipient` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], distribution: cur };
  const next = cloneDistribution(cur);
  next.failedRecipients = without(next.failedRecipients, recipient);
  next.deliveryAttempts += 1;
  return { valid: true, errors: [], warnings: [], distribution: applyMeta(settle(next), opts) };
}

function acknowledgeRecipient(distribution, recipient, options) {
  const opts = obj(options);
  const cur = createDistribution(distribution);
  const errors = actionCheck(cur, recipient);
  if (errors.length === 0 && !cur.completedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'NOT_DELIVERED', message: `${recipient} has not been delivered to` });
  else if (errors.length === 0 && cur.acknowledgedRecipients.includes(recipient)) errors.push({ field: 'recipient', code: 'DUPLICATE_ACKNOWLEDGEMENT', message: `${recipient} already acknowledged` });
  if (errors.length > 0) return { valid: false, errors, warnings: [], distribution: cur };
  const next = cloneDistribution(cur);
  next.acknowledgedRecipients = uniqPush(next.acknowledgedRecipients, recipient);
  return { valid: true, errors: [], warnings: [], distribution: applyMeta(settle(next), opts) };
}

function cancelDistribution(distribution, options) {
  const opts = obj(options);
  const cur = createDistribution(distribution);
  if (cur.status === 'COMPLETED' || cur.status === 'FAILED' || cur.status === 'CANCELLED') {
    return { valid: false, errors: [{ field: 'status', code: 'NOT_CANCELLABLE', message: `cannot cancel in status ${cur.status}` }], warnings: [], distribution: cur };
  }
  const next = cloneDistribution(cur);
  next.status = 'CANCELLED';
  next.pendingRecipients = next.recipients.filter((r) => !next.completedRecipients.includes(r) && !next.failedRecipients.includes(r));
  return { valid: true, errors: [], warnings: [], distribution: applyMeta(next, opts) };
}

function validateDistribution(distribution) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(distribution)) {
    result.errors.push({ field: null, code: 'INVALID_DISTRIBUTION', message: 'distribution must be a plain object' });
    result.valid = false;
    return result;
  }
  const modeId = (typeof distribution.mode === 'string') ? distribution.mode.trim() : '';
  const modeKnown = isKnownDocumentDistribution(modeId);
  if (modeId !== '' && !modeKnown) result.warnings.push({ field: 'mode', code: 'UNKNOWN_MODE', message: `unknown mode: ${modeId}` });

  const status = (typeof distribution.status === 'string') ? distribution.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  if (modeKnown && typeof distribution.channel === 'string' && distribution.channel !== '') {
    const allowed = getDocumentDistribution(modeId).allowedChannels;
    if (allowed.length > 0 && !allowed.includes(distribution.channel)) {
      result.warnings.push({ field: 'channel', code: 'INVALID_CHANNEL', message: `channel ${distribution.channel} is not allowed for mode ${modeId}` });
    }
  }
  if (Array.isArray(distribution.recipients) && uniqDeep(distribution.recipients).length !== distribution.recipients.length) {
    result.errors.push({ field: 'recipients', code: 'DUPLICATE_RECIPIENT', message: 'recipients contains duplicates' });
  }
  const recipients = Array.isArray(distribution.recipients) ? distribution.recipients : [];
  for (const key of ['completedRecipients', 'failedRecipients']) {
    if (Array.isArray(distribution[key]) && distribution[key].some((r) => !recipients.includes(r))) {
      result.warnings.push({ field: key, code: 'INCONSISTENT_RECIPIENT', message: `${key} contains a recipient not in recipients` });
    }
  }
  if (Array.isArray(distribution.acknowledgedRecipients) && Array.isArray(distribution.completedRecipients)
      && distribution.acknowledgedRecipients.some((r) => !distribution.completedRecipients.includes(r))) {
    result.warnings.push({ field: 'acknowledgedRecipients', code: 'INCONSISTENT_ACKNOWLEDGEMENT', message: 'an acknowledged recipient has not been delivered to' });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeDistribution(distribution) {
  const d = createDistribution(distribution);
  for (const [name, kind] of DISTRIBUTION_FIELDS) {
    if (kind === 'string' && typeof d[name] === 'string') d[name] = d[name].trim();
    else if (kind === 'object') d[name] = normalizeObject(d[name]);
    else if (kind === 'array') d[name] = normalizeArray(d[name]);
  }
  return d;
}

function mergeDistribution(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeDistribution(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareDistribution(a, b) {
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

function generateDistributionSnapshot(distribution) {
  const normalized = normalizeDistribution(distribution);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), distribution: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createDistribution,
  completeRecipient,
  failRecipient,
  acknowledgeRecipient,
  retryRecipient,
  cancelDistribution,
  validateDistribution,
  normalizeDistribution,
  cloneDistribution,
  freezeDistribution,
  mergeDistribution,
  compareDistribution,
  generateDistributionSnapshot,
};
