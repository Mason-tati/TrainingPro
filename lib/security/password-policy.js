// WP-13 · S4 — Password policy (ADVISORY only).
//
// Dependency-free, pure evaluation. No DB, no network, no logging, no Express.
// This module is advisory ONLY: it is NOT wired to reject logins or password
// changes. It returns a structured assessment so callers (future work / UI) can
// surface guidance. Issue strings are generic and NEVER echo the password value.
'use strict';

const MIN_LENGTH = 12;

// Common/example passwords that must always fail (compared case-insensitively).
const COMMON_PASSWORDS = new Set([
  'password', 'password123', 'admin', 'admin123', 'qwerty', 'welcome', 'letmein',
]);

// The five composition criteria, each a generic issue message (no password echo).
const CRITERIA = [
  { test: (p) => p.length >= MIN_LENGTH, issue: `Password must be at least ${MIN_LENGTH} characters.` },
  { test: (p) => /[a-z]/.test(p), issue: 'Password must contain a lowercase letter.' },
  { test: (p) => /[A-Z]/.test(p), issue: 'Password must contain an uppercase letter.' },
  { test: (p) => /[0-9]/.test(p), issue: 'Password must contain a number.' },
  { test: (p) => /[^A-Za-z0-9]/.test(p), issue: 'Password must contain a symbol.' },
];

// Evaluate a password. Returns { valid, score, issues }.
//   valid  — true only when every criterion passes AND it is not a common password.
//   score  — 0..5, the number of composition criteria satisfied (advisory strength).
//   issues — stable, descriptive, password-free strings (empty when valid).
// Never throws; non-string input fails safely.
function evaluatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, score: 0, issues: ['Password must be a non-empty string.'] };
  }

  const issues = [];
  let score = 0;
  for (const c of CRITERIA) {
    if (c.test(password)) score += 1;
    else issues.push(c.issue);
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    issues.push('Password is too common and easily guessed.');
  }

  return { valid: issues.length === 0, score, issues };
}

module.exports = { evaluatePassword, MIN_LENGTH };
