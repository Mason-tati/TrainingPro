// WP-15 · D1 — Sensitive-data category registry (governance foundation).
//
// Immutable, report-only categories of data that must never appear in audit/log
// free-text, each with a redaction posture (drop | mask | hash_reference). Pure,
// dependency-free, deep-frozen, copy-on-read, never throws; unknown ids fall back
// to a fail-safe `drop` default. Unwired.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}
// Allowed redactions: 'drop' (never store), 'mask' (partial), 'hash_reference'.
function entry(id, description, redaction) {
  return { id, description, redaction };
}

const SENSITIVE_DATA = deepFreeze({
  credentials: entry('credentials', 'Passwords, hashes, tokens, session ids, cookies', 'drop'),
  pii: entry('pii', 'Personally identifiable information', 'mask'),
  medical: entry('medical', 'Medical / health information', 'drop'),
  disciplinary_freetext: entry('disciplinary_freetext', 'Free-text disciplinary details', 'drop'),
  financial: entry('financial', 'Financial information', 'mask'),
  ai_content: entry('ai_content', 'AI prompts / completions / raw model output', 'drop'),
});

const SENSITIVE_DATA_IDS = Object.freeze(Object.keys(SENSITIVE_DATA));

// Fail-safe default for an unrecognised category: treat as drop.
const SAFE_DEFAULT = deepFreeze(entry('unknown', 'Unrecognised sensitive category — treated as drop (fail-safe)', 'drop'));

function copy(e) { return { id: e.id, description: e.description, redaction: e.redaction }; }

function getSensitiveCategory(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(SENSITIVE_DATA, id);
  return copy(known ? SENSITIVE_DATA[id] : SAFE_DEFAULT);
}

function listSensitiveCategories() {
  return SENSITIVE_DATA_IDS.map((k) => copy(SENSITIVE_DATA[k]));
}

module.exports = { SENSITIVE_DATA, SENSITIVE_DATA_IDS, getSensitiveCategory, listSensitiveCategories };
