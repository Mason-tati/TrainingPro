// WP-18 · E11 — Document approval history (Enterprise Document Engine).
//
// An ordered, in-memory log of approval decisions: append/replace/remove, find
// (by key / latest / previous / next), list, compare, validate, normalize, clone, freeze.
// Delegates per-decision work to the sibling approval manager. Deterministic, never throws,
// never mutates caller objects, copy-on-read. UNWIRED.
'use strict';

const manager = require('./document-approval-manager');

const HISTORY_FIELDS = ['approvalId', 'workflow', 'decisions', 'metadata', 'futureReserved'];

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

// A stable key for a decision: timestamp, else approvalId, else the decision label.
function decisionKey(d) {
  const s = obj(d);
  const key = pickString(s.timestamp, s.approvalId, s.decision, s.status);
  return (key === undefined) ? '' : key;
}
function timestampOf(d) { const v = obj(d).timestamp; return (typeof v === 'string') ? v : ''; }

// Chronological order: by timestamp, then a stable insertion-index tiebreak.
function orderDecisions(h) {
  return h.decisions
    .map((d, i) => [d, i])
    .sort((a, b) => {
      const ta = timestampOf(a[0]);
      const tb = timestampOf(b[0]);
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return a[1] - b[1];
    })
    .map((p) => p[0]);
}

function normalizeDecisions(list) {
  return (Array.isArray(list) ? list : []).map((d) => manager.createApproval(d));
}

// ---- public ----

function createHistory(input) {
  const src = obj(input);
  return {
    approvalId: (typeof src.approvalId === 'string') ? src.approvalId : ((src.approvalId === undefined || src.approvalId === null) ? null : src.approvalId),
    workflow: (typeof src.workflow === 'string' && src.workflow !== '') ? src.workflow : 'NONE',
    decisions: normalizeDecisions(src.decisions),
    metadata: isPlainObject(src.metadata) ? deepClone(src.metadata) : {},
    futureReserved: Array.isArray(src.futureReserved) ? deepClone(src.futureReserved) : [],
  };
}

function listDecisions(history) { return createHistory(history).decisions; }

function appendDecision(history, decision) {
  const h = createHistory(history);
  h.decisions = h.decisions.concat([manager.createApproval(decision)]);
  return h;
}

function replaceDecision(history, key, decision) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const replacement = manager.createApproval(decision);
  h.decisions = h.decisions.map((d) => (decisionKey(d) === target ? replacement : d));
  return h;
}

function removeDecision(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  h.decisions = h.decisions.filter((d) => decisionKey(d) !== target);
  return h;
}

function findDecision(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const found = h.decisions.find((d) => decisionKey(d) === target);
  return found ? deepClone(found) : null;
}

function findLatest(history) {
  const h = createHistory(history);
  if (h.decisions.length === 0) return null;
  const sorted = orderDecisions(h);
  return deepClone(sorted[sorted.length - 1]);
}

function findPrevious(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderDecisions(h);
  const idx = sorted.findIndex((d) => decisionKey(d) === target);
  return (idx > 0) ? deepClone(sorted[idx - 1]) : null;
}

function findNext(history, key) {
  const h = createHistory(history);
  const target = String(key === undefined || key === null ? '' : key);
  const sorted = orderDecisions(h);
  const idx = sorted.findIndex((d) => decisionKey(d) === target);
  return (idx !== -1 && idx < sorted.length - 1) ? deepClone(sorted[idx + 1]) : null;
}

function compareHistory(a, b) {
  const ha = createHistory(a);
  const hb = createHistory(b);
  const mapA = new Map();
  const mapB = new Map();
  for (const d of ha.decisions) mapA.set(decisionKey(d), d);
  for (const d of hb.decisions) mapB.set(decisionKey(d), d);
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
  const result = { valid: true, errors: [], warnings: [], duplicateDecisions: [] };
  if (!isPlainObject(history)) {
    result.errors.push({ field: null, code: 'INVALID_HISTORY', message: 'history must be a plain object' });
    result.valid = false;
    return result;
  }
  const decisions = Array.isArray(history.decisions) ? history.decisions : [];
  if (!Array.isArray(history.decisions)) {
    result.errors.push({ field: 'decisions', code: 'INVALID_DECISIONS', message: 'decisions must be an array' });
  }
  const present = new Set();
  for (const d of decisions) {
    const key = decisionKey(d);
    if (present.has(key)) { if (!result.duplicateDecisions.includes(key)) result.duplicateDecisions.push(key); }
    present.add(key);
    const vv = manager.validateApproval(d);
    for (const e of vv.errors) result.errors.push({ field: `decisions[${key}].${e.field}`, code: e.code, message: e.message });
    for (const w of vv.warnings) result.warnings.push({ field: `decisions[${key}].${w.field}`, code: w.code, message: w.message });
  }
  if (result.duplicateDecisions.length > 0) {
    result.errors.push({ field: 'decisions', code: 'DUPLICATE_DECISION', message: `duplicate decisions: ${result.duplicateDecisions.join(', ')}` });
  }
  result.duplicateDecisions.sort();
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
  const sorted = orderDecisions({ decisions: h.decisions.map((d) => manager.normalizeApproval(d)) });
  const built = {
    approvalId: h.approvalId,
    workflow: h.workflow,
    decisions: sorted,
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
  appendDecision,
  replaceDecision,
  removeDecision,
  findDecision,
  findLatest,
  findPrevious,
  findNext,
  listDecisions,
  compareHistory,
  validateHistory,
  normalizeHistory,
  cloneHistory,
  freezeHistory,
};
