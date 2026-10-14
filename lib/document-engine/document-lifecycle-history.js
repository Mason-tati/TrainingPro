// WP-18 · E10 — Document lifecycle history (Enterprise Document Engine).
//
// An ordered, in-memory log of lifecycle transitions: append/replace/remove, find
// (by key / latest / previous / next), compare, validate, normalize, clone, freeze.
// Delegates per-transition work to the sibling lifecycle manager. Deterministic, never
// throws, never mutates caller objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-lifecycle-manager');

const HISTORY_FIELDS = ['documentId', 'workflow', 'transitions', 'metadata', 'futureReserved'];

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

// A stable key for a transition: timestamp if present, else the target status.
function transitionKey(t) {
  const s = obj(t);
  const key = pickString(s.timestamp, s.status);
  return (key === undefined) ? '' : key;
}

function timestampOf(t) { const v = obj(t).timestamp; return (typeof v === 'string') ? v : ''; }

// Chronological order: by timestamp, then a stable insertion-index tiebreak.
function orderTransitions(h) {
  return h.transitions
    .map((t, i) => [t, i])
    .sort((a, b) => {
      const ta = timestampOf(a[0]);
      const tb = timestampOf(b[0]);
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a[1] - b[1];
    })
    .map((p) => p[0]);
}

function normalizeTransitions(list) {
  return (Array.isArray(list) ? list : []).map((t) => manager.createLifecycle(t));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    documentId: (typeof src.documentId === 'string') ? src.documentId : ((src.documentId === undefined || src.documentId === null) ? null : src.documentId),
    workflow: (typeof src.workflow === 'string' && src.workflow !== '') ? src.workflow : 'NONE',
    transitions: normalizeTransitions(src.transitions),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function appendTransition(history, transition) {
  const h = createHistory(history);
  h.transitions = h.transitions.concat([manager.createLifecycle(transition)]);
  return h;
}

function replaceTransition(history, key, transition) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createLifecycle(transition);
  h.transitions = h.transitions.map((t) => (transitionKey(t) === target ? replacement : t));
  return h;
}

function removeTransition(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.transitions = h.transitions.filter((t) => transitionKey(t) !== target);
  return h;
}

function findTransition(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.transitions.find((t) => transitionKey(t) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.transitions.length === 0) return null;
  const sorted = orderTransitions(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderTransitions(h);
  const idx = sorted.findIndex((t) => transitionKey(t) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderTransitions(h);
  const idx = sorted.findIndex((t) => transitionKey(t) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const t of ha.transitions) mapA.set(transitionKey(t), t);
  for (const t of hb.transitions) mapB.set(transitionKey(t), t);
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
  const result = { valid: true, errors: [], warnings: [], duplicateTransitions: [], brokenSequence: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const transitions = Array.isArray(history.transitions) ? history.transitions : [];
  if (!Array.isArray(history.transitions)) {
    result.errors.push({ field: 'transitions', code: 'INVALID_TRANSITIONS', message: 'transitions must be an array' });
  }
  const present = new Set();
  for (const t of transitions) {
    const key = transitionKey(t);
    if (present.has(key)) { if (!result.duplicateTransitions.includes(key)) result.duplicateTransitions.push(key); }
    present.add(key);
    const vv = manager.validateLifecycle(t);
    for (const e of vv.errors) result.errors.push({ field: `transitions[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `transitions[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateTransitions.length > 0) {
    result.errors.push({ field: 'transitions', code: 'DUPLICATE_TRANSITION', message: `duplicate transitions: ${result.duplicateTransitions.join(', ')}` });
  }
  // sequence continuity: each transition's previousStatus should match the prior status
  for (let i = 1; i < transitions.length; i += 1) {
    const prevStatus = obj(transitions[i - 1]).status;
    const declaredPrev = obj(transitions[i]).previousStatus;
    if (typeof declaredPrev === 'string' && declaredPrev !== '' && declaredPrev !== prevStatus) {
      const gap = `${transitionKey(transitions[i])}:${declaredPrev}≠${prevStatus}`;
      if (!result.brokenSequence.includes(gap)) result.brokenSequence.push(gap);
    }
  }
  if (result.brokenSequence.length > 0) {
    result.warnings.push({ field: 'transitions', code: 'BROKEN_SEQUENCE', message: `broken sequence: ${result.brokenSequence.join(', ')}` });
  }
  result.duplicateTransitions.sort();
  result.brokenSequence.sort();
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
  const sorted = orderTransitions({ transitions: h.transitions.map((t) => manager.normalizeLifecycle(t)) });
  const built = {
    documentId: h.documentId,
    workflow: h.workflow,
    transitions: sorted,
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
  appendTransition,
  replaceTransition,
  removeTransition,
  findTransition,
  findLatest,
  findPrevious,
  findNext,
  normalizeHistory,
  validateHistory,
  compareHistory,
  cloneHistory,
  freezeHistory,
};
