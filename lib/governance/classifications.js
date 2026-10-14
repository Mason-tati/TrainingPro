// WP-15 · D1 — Data classification registry (governance foundation).
//
// Immutable, extensible, report-only enterprise data classifications. Pure and
// dependency-free; deep-frozen; copy-on-read; never throws; unknown ids fall back
// to the safe default PUBLIC. NOTHING in production consumes this yet.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}
function entry(id, description, sensitivityRank) {
  return { id, description, sensitivityRank, extensible: true };
}

// Ordered by sensitivityRank (ascending). The set is intentionally extensible —
// adding a label is a data-only change.
const CLASSIFICATIONS = deepFreeze({
  PUBLIC: entry('PUBLIC', 'Public / non-sensitive information', 0),
  INTERNAL: entry('INTERNAL', 'Internal business information', 1),
  CONFIDENTIAL: entry('CONFIDENTIAL', 'Confidential business information', 2),
  HIGHLY_CONFIDENTIAL: entry('HIGHLY_CONFIDENTIAL', 'Highly confidential / restricted information', 3),
  SAFETY_CRITICAL: entry('SAFETY_CRITICAL', 'Safety-critical operational data', 4),
  HR_CONFIDENTIAL: entry('HR_CONFIDENTIAL', 'Human-resources confidential data', 5),
  MEDICAL: entry('MEDICAL', 'Medical / health information', 6),
  FINANCIAL: entry('FINANCIAL', 'Financial information', 7),
  LEGAL: entry('LEGAL', 'Legal / privileged information', 8),
  AI_GENERATED: entry('AI_GENERATED', 'AI-generated content, not yet human-verified', 9),
  AI_VERIFIED: entry('AI_VERIFIED', 'AI-generated content, human-verified', 10),
  EXPORT_CONTROLLED: entry('EXPORT_CONTROLLED', 'Export-controlled information', 11),
});

const CLASSIFICATION_IDS = Object.freeze(Object.keys(CLASSIFICATIONS));

function copy(e) {
  return { id: e.id, description: e.description, sensitivityRank: e.sensitivityRank, extensible: e.extensible };
}

// Fresh copy of the entry, or a copy of the safe default (PUBLIC) for unknown ids.
function getClassification(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(CLASSIFICATIONS, id);
  return copy(known ? CLASSIFICATIONS[id] : CLASSIFICATIONS.PUBLIC);
}

function listClassifications() {
  return CLASSIFICATION_IDS.map((k) => copy(CLASSIFICATIONS[k]));
}

module.exports = { CLASSIFICATIONS, CLASSIFICATION_IDS, getClassification, listClassifications };
