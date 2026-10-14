// WP-18 · E12 — Document review manager (Enterprise Document Engine).
//
// Evaluates review assignments, decisions, progress, and completion entirely in memory.
// NOT an approval/workflow/notification engine and NOT persistence — it only decides which
// review actions are valid and produces deterministic review objects. Scheme-aware via the
// WP-17 workflow registry (its only import). Deterministic, never throws, never mutates
// callers, deep-immutable on request, copy-on-read. UNWIRED.
'use strict';

const { getDocumentWorkflow, isKnownDocumentWorkflow } = require('../document/document-workflows');

const REVIEW_STATES = ['PENDING', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'COMPLETED', 'CANCELLED', 'RETURNED', 'UNKNOWN'];
const STATE_SET = new Set(REVIEW_STATES);
const TERMINAL = new Set(['COMPLETED', 'CANCELLED']);

const REVIEW_FIELDS = [
  ['reviewId', 'string'],
  ['workflow', 'string'],
  ['status', 'string'],
  ['currentStage', 'int'],
  ['totalStages', 'int'],
  ['reviewers', 'array'],
  ['completedBy', 'array'],
  ['returnedBy', 'array'],
  ['decision', 'string'],
  ['comments', 'string'],
  ['timestamp', 'date'],
  ['metadata', 'object'],
  ['futureReserved', 'array'],
];
const SNAPSHOT_SCHEMA = 'enterprise-review.v1';

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
  if (kind === 'date') return (typeof val === 'string' && val !== '') ? val : null;
  if (kind === 'object') return isPlainObject(val) ? deepClone(val) : {};
  return Array.isArray(val) ? deepClone(val) : [];
}

function uniqPush(arr, value) { return arr.includes(value) ? arr.slice() : arr.concat([value]); }
function applyMeta(next, opts) {
  if (typeof opts.comments === 'string') next.comments = opts.comments;
  if (typeof opts.timestamp === 'string') next.timestamp = opts.timestamp;
  return next;
}

// ---- public ----

function createReview(input, options) {
  const src = obj(input);
  const opts = obj(options);
  const r = {};
  for (const [name, kind] of REVIEW_FIELDS) r[name] = coerce(kind, src[name]);
  const workflowId = pickString(src.workflow, opts.workflow, opts.defaultWorkflow);
  r.workflow = (workflowId === undefined) ? 'NONE' : workflowId;
  const statusId = pickString(src.status, opts.status, opts.defaultStatus);
  r.status = (statusId === undefined) ? 'PENDING' : statusId;
  r.currentStage = (r.currentStage >= 1) ? r.currentStage : 1;
  r.totalStages = (r.totalStages >= 1) ? r.totalStages : 1;
  return r;
}

function cloneReview(review) { return deepClone(obj(review)); }
function freezeReview(review) { return deepFreeze(deepClone(obj(review))); }

function reviewCheck(cur, reviewer) {
  const errors = [];
  if (TERMINAL.has(cur.status)) errors.push({ field: 'status', code: 'NOT_REVIEWABLE', message: `cannot review in status ${cur.status}` });
  if (!isNonEmptyString(reviewer)) errors.push({ field: 'reviewer', code: 'INVALID_REVIEWER', message: 'reviewer must be a non-empty string' });
  else if (cur.completedBy.includes(reviewer)) errors.push({ field: 'reviewer', code: 'DUPLICATE_REVIEWER', message: `${reviewer} has already completed` });
  return { valid: errors.length === 0, errors, warnings: [] };
}
function returnCheck(cur, reviewer) {
  const errors = [];
  if (TERMINAL.has(cur.status)) errors.push({ field: 'status', code: 'NOT_REVIEWABLE', message: `cannot return in status ${cur.status}` });
  if (!isNonEmptyString(reviewer)) errors.push({ field: 'reviewer', code: 'INVALID_REVIEWER', message: 'reviewer must be a non-empty string' });
  return { valid: errors.length === 0, errors, warnings: [] };
}

function canReview(review, reviewer) {
  return reviewCheck(createReview(review), reviewer).valid;
}

function completeReview(review, reviewer, options) {
  const opts = obj(options);
  const cur = createReview(review);
  const wf = getDocumentWorkflow(cur.workflow);
  const check = reviewCheck(cur, reviewer);
  if (!check.valid) return { valid: false, errors: check.errors, warnings: check.warnings, review: cur };
  const next = cloneReview(cur);
  next.completedBy = uniqPush(next.completedBy, reviewer);
  next.decision = 'complete';
  const perStage = (wf.allowsParallelReview === true && next.reviewers.length > 0) ? next.reviewers.length : 1;
  const count = next.completedBy.length;
  next.currentStage = Math.min(next.totalStages, Math.floor((count - 1) / perStage) + 1);
  next.status = (count >= next.totalStages * perStage) ? 'COMPLETED' : 'UNDER_REVIEW';
  return { valid: true, errors: [], warnings: [], review: applyMeta(next, opts) };
}

function returnForChanges(review, reviewer, options) {
  const opts = obj(options);
  const cur = createReview(review);
  const check = returnCheck(cur, reviewer);
  if (!check.valid) return { valid: false, errors: check.errors, warnings: check.warnings, review: cur };
  const next = cloneReview(cur);
  next.returnedBy = uniqPush(next.returnedBy, reviewer);
  next.decision = 'return';
  next.status = 'CHANGES_REQUESTED';
  return { valid: true, errors: [], warnings: [], review: applyMeta(next, opts) };
}

function cancelReview(review, options) {
  const opts = obj(options);
  const cur = createReview(review);
  if (TERMINAL.has(cur.status)) {
    return { valid: false, errors: [{ field: 'status', code: 'NOT_CANCELLABLE', message: `cannot cancel in status ${cur.status}` }], warnings: [], review: cur };
  }
  const next = cloneReview(cur);
  next.decision = 'cancel';
  next.status = 'CANCELLED';
  return { valid: true, errors: [], warnings: [], review: applyMeta(next, opts) };
}

function restartReview(review, options) {
  const opts = obj(options);
  const cur = createReview(review);
  const next = cloneReview(cur);
  next.status = 'PENDING';
  next.currentStage = 1;
  next.completedBy = [];
  next.returnedBy = [];
  next.decision = '';
  return { valid: true, errors: [], warnings: [], review: applyMeta(next, opts) };
}

function nextStage(review) {
  const next = createReview(review);
  if (next.currentStage < next.totalStages) next.currentStage += 1;
  return next;
}
function previousStage(review) {
  const next = createReview(review);
  if (next.currentStage > 1) next.currentStage -= 1;
  return next;
}

function validateReview(review) {
  const result = { valid: true, errors: [], warnings: [] };
  if (!isPlainObject(review)) {
    result.errors.push({ field: null, code: 'INVALID_REVIEW', message: 'review must be a plain object' });
    result.valid = false;
    return result;
  }
  const workflowId = (typeof review.workflow === 'string') ? review.workflow.trim() : '';
  if (workflowId !== '' && !isKnownDocumentWorkflow(workflowId)) result.warnings.push({ field: 'workflow', code: 'UNKNOWN_WORKFLOW', message: `unknown workflow: ${workflowId}` });

  const status = (typeof review.status === 'string') ? review.status.trim() : '';
  if (status === '') result.errors.push({ field: 'status', code: 'MISSING_STATUS', message: 'status is required' });
  else if (!STATE_SET.has(status)) result.errors.push({ field: 'status', code: 'INVALID_STATUS', message: `invalid status: ${status}` });

  for (const part of ['currentStage', 'totalStages']) {
    if (hasOwn(review, part) && !(Number.isInteger(review[part]) && review[part] >= 1)) {
      result.errors.push({ field: part, code: 'INVALID_STAGE', message: `${part} must be a positive integer` });
    }
  }
  if (Number.isInteger(review.currentStage) && Number.isInteger(review.totalStages) && review.currentStage > review.totalStages) {
    result.errors.push({ field: 'currentStage', code: 'STAGE_RANGE', message: 'currentStage exceeds totalStages' });
  }
  if (hasOwn(review, 'reviewers') && !Array.isArray(review.reviewers)) {
    result.errors.push({ field: 'reviewers', code: 'INVALID_REVIEWERS', message: 'reviewers must be an array' });
  } else if (Array.isArray(review.reviewers) && uniqDeep(review.reviewers).length !== review.reviewers.length) {
    result.errors.push({ field: 'reviewers', code: 'DUPLICATE_REVIEWER', message: 'reviewers contains duplicates' });
  }
  if (Array.isArray(review.completedBy) && uniqDeep(review.completedBy).length !== review.completedBy.length) {
    result.errors.push({ field: 'completedBy', code: 'DUPLICATE_REVIEWER', message: 'completedBy contains duplicates' });
  }
  if (Array.isArray(review.completedBy) && Array.isArray(review.returnedBy) && review.completedBy.some((x) => review.returnedBy.includes(x))) {
    result.warnings.push({ field: 'completedBy', code: 'DECISION_CONFLICT', message: 'a reviewer appears in both completedBy and returnedBy' });
  }
  if (status === 'COMPLETED' && typeof review.decision === 'string' && review.decision !== '' && review.decision !== 'complete') {
    result.warnings.push({ field: 'decision', code: 'DECISION_MISMATCH', message: `decision ${review.decision} inconsistent with status ${status}` });
  }
  result.valid = result.errors.length === 0;
  return result;
}

function normalizeReview(review) {
  const r = createReview(review);
  for (const [name, kind] of REVIEW_FIELDS) {
    if (kind === 'string' && typeof r[name] === 'string') r[name] = r[name].trim();
    else if (kind === 'object') r[name] = normalizeObject(r[name]);
    else if (kind === 'array') r[name] = normalizeArray(r[name]);
  }
  return r;
}

function mergeReview(base, incoming, options) {
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
      if (objects === 'merge') out[key] = mergeReview(bv, iv, options);
      else out[key] = (strategy === 'keepExisting') ? bv : iv;
    } else {
      out[key] = (strategy === 'keepExisting') ? bv : iv;
    }
  }
  return out;
}

function compareReview(a, b) {
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

function generateReviewSnapshot(review) {
  const normalized = normalizeReview(review);
  const canonical = JSON.stringify(normalized);
  const snapshot = { schema: SNAPSHOT_SCHEMA, digest: fnv1a(canonical), review: normalized };
  return deepFreeze(deepClone(snapshot));
}

module.exports = {
  createReview,
  completeReview,
  returnForChanges,
  cancelReview,
  restartReview,
  nextStage,
  previousStage,
  canReview,
  validateReview,
  normalizeReview,
  cloneReview,
  freezeReview,
  mergeReview,
  compareReview,
  generateReviewSnapshot,
};
