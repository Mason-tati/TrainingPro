// WP-17 · D1 — Document review-frequency registry (document-management foundation).
//
// Immutable, report-only review cadences with a default interval in months. Pure,
// dependency-free, deep-frozen, copy-on-read, never throws; unknown ids fall back to
// a fail-safe NONE-like default. UNWIRED — nothing in production imports it.
'use strict';

function deepFreeze(o) {
  for (const v of Object.values(o)) { if (v && typeof v === 'object') deepFreeze(v); }
  return Object.freeze(o);
}

// defaultMonths: fixed interval in months; null where the interval is not fixed
// (NONE = no scheduled review; CUSTOM = interval defined per-document elsewhere).
function freq(id, displayName, description, defaultMonths) {
  return { id, displayName, description, defaultMonths };
}

const REVIEW_FREQUENCIES = deepFreeze({
  NONE: freq('NONE', 'None', 'No scheduled review', 0),
  MONTHLY: freq('MONTHLY', 'Monthly', 'Review every month', 1),
  QUARTERLY: freq('QUARTERLY', 'Quarterly', 'Review every three months', 3),
  HALF_YEARLY: freq('HALF_YEARLY', 'Half-Yearly', 'Review every six months', 6),
  YEARLY: freq('YEARLY', 'Yearly', 'Review every twelve months', 12),
  TWO_YEAR: freq('TWO_YEAR', 'Two-Yearly', 'Review every two years', 24),
  THREE_YEAR: freq('THREE_YEAR', 'Three-Yearly', 'Review every three years', 36),
  FIVE_YEAR: freq('FIVE_YEAR', 'Five-Yearly', 'Review every five years', 60),
  CUSTOM: freq('CUSTOM', 'Custom', 'Custom review interval defined per document', null),
});

const REVIEW_FREQUENCY_IDS = Object.freeze(Object.keys(REVIEW_FREQUENCIES));

// Fail-safe default for an unrecognised frequency: no scheduled review.
const SAFE_DEFAULT = deepFreeze(freq('unknown', 'Unknown', 'Unrecognised review frequency — safe default', 0));

function copyFreq(f) { return Object.assign({}, f); }

function getReviewFrequency(id) {
  const known = typeof id === 'string' && Object.prototype.hasOwnProperty.call(REVIEW_FREQUENCIES, id);
  return copyFreq(known ? REVIEW_FREQUENCIES[id] : SAFE_DEFAULT);
}

function listReviewFrequencies() {
  return REVIEW_FREQUENCY_IDS.map((k) => copyFreq(REVIEW_FREQUENCIES[k]));
}

module.exports = { REVIEW_FREQUENCIES, REVIEW_FREQUENCY_IDS, getReviewFrequency, listReviewFrequencies };
