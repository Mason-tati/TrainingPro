// WP-18 · E12 — Document review history (Enterprise Document Engine).
//
// An ordered, in-memory log of review events: append/replace/remove, find (by key /
// latest / previous / next), list, compare, validate, normalize, clone, freeze. Delegates
// per-review work to the sibling review manager. Deterministic, never throws, never mutates
// caller objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-review-manager');

const HISTORY_FIELDS = ['reviewId', 'workflow', 'reviews', 'metadata', 'futureReserved'];

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

// A stable key for a review event: timestamp, else reviewId, else decision/status.
function reviewKey(r) {
  const s = obj(r);
  const key = pickString(s.timestamp, s.reviewId, s.decision, s.status);
  return (key === undefined) ? '' : key;
}
function timestampOf(r) { const v = obj(r).timestamp; return (typeof v === 'string') ? v : ''; }

// Chronological order: by timestamp, then a stable insertion-index tiebreak.
function orderReviews(h) {
  return h.reviews
    .map((r, i) => [r, i])
    .sort((a, b) => {
      const ta = timestampOf(a[0]);
      const tb = timestampOf(b[0]);
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a[1] - b[1];
    })
    .map((p) => p[0]);
}

function normalizeReviews(list) {
  return (Array.isArray(list) ? list : []).map((r) => manager.createReview(r));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    reviewId: (typeof src.reviewId === 'string') ? src.reviewId : ((src.reviewId === undefined || src.reviewId === null) ? null : src.reviewId),
    workflow: (typeof src.workflow === 'string' && src.workflow !== '') ? src.workflow : 'NONE',
    reviews: normalizeReviews(src.reviews),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listReviews(history) { return createHistory(history).reviews; }

function appendReview(history, review) {
  const h = createHistory(history);
  h.reviews = h.reviews.concat([manager.createReview(review)]);
  return h;
}

function replaceReview(history, key, review) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createReview(review);
  h.reviews = h.reviews.map((r) => (reviewKey(r) === target ? replacement : r));
  return h;
}

function removeReview(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.reviews = h.reviews.filter((r) => reviewKey(r) !== target);
  return h;
}

function findReview(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.reviews.find((r) => reviewKey(r) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.reviews.length === 0) return null;
  const sorted = orderReviews(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderReviews(h);
  const idx = sorted.findIndex((r) => reviewKey(r) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderReviews(h);
  const idx = sorted.findIndex((r) => reviewKey(r) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const r of ha.reviews) mapA.set(reviewKey(r), r);
  for (const r of hb.reviews) mapB.set(reviewKey(r), r);
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
  const result = { valid: true, errors: [], warnings: [], duplicateReviews: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const reviews = Array.isArray(history.reviews) ? history.reviews : [];
  if (!Array.isArray(history.reviews)) {
    result.errors.push({ field: 'reviews', code: 'INVALID_REVIEWS', message: 'reviews must be an array' });
  }
  const present = new Set();
  for (const r of reviews) {
    const key = reviewKey(r);
    if (present.has(key)) { if (!result.duplicateReviews.includes(key)) result.duplicateReviews.push(key); }
    present.add(key);
    const vv = manager.validateReview(r);
    for (const e of vv.errors) result.errors.push({ field: `reviews[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `reviews[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateReviews.length > 0) {
    result.errors.push({ field: 'reviews', code: 'DUPLICATE_REVIEW', message: `duplicate reviews: ${result.duplicateReviews.join(', ')}` });
  }
  result.duplicateReviews.sort();
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
  const sorted = orderReviews({ reviews: h.reviews.map((r) => manager.normalizeReview(r)) });
  const built = {
    reviewId: h.reviewId,
    workflow: h.workflow,
    reviews: sorted,
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
  appendReview,
  replaceReview,
  removeReview,
  findReview,
  findLatest,
  findPrevious,
  findNext,
  listReviews,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
