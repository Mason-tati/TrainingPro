// WP-14 · A5 — Route permission requirement registry (RBAC foundation).
//
// A pure, immutable map from (HTTP method, Express-style path pattern) → the
// permissions a FUTURE enforcement layer will require. Every entry is `report`
// mode — nothing enforces anything, and NOTHING in production imports this yet.
// No DB, no Express, no logging, no regex built from caller input (no injection).
'use strict';

// Each rule: { method, pathPattern, permissions[], description, mode:'report' }.
function rule(method, pathPattern, permissions, description) {
  return { method, pathPattern, permissions, description, mode: 'report' };
}

// Report-only requirement rules. Path patterns are advisory (route families), not
// necessarily 1:1 with live routes. All permissions are A1 permission ids.
const RAW_RULES = [
  // Users
  rule('GET', '/api/users', ['users.read'], 'List users'),
  rule('POST', '/api/users', ['users.write'], 'Create user'),
  rule('GET', '/api/users/:id', ['users.read'], 'View a user'),
  rule('PUT', '/api/users/:id', ['users.write'], 'Update a user'),
  rule('PATCH', '/api/users/:id', ['users.write'], 'Modify a user'),
  rule('DELETE', '/api/users/:id', ['users.delete'], 'Delete a user'),
  // Staff (people records → user permissions)
  rule('GET', '/api/staff', ['users.read'], 'List staff'),
  rule('POST', '/api/staff', ['users.write'], 'Create staff'),
  rule('GET', '/api/staff/:id', ['users.read'], 'View a staff member'),
  rule('PUT', '/api/staff/:id', ['users.write'], 'Update a staff member'),
  rule('DELETE', '/api/staff/:id', ['users.delete'], 'Delete a staff member'),
  // Reports (exact export rule is more specific than the wildcard)
  rule('GET', '/api/reports/export', ['reports.export'], 'Export a report'),
  rule('GET', '/api/reports/*', ['reports.read'], 'View reports'),
  // Analytics (a method-specific rule plus a wildcard-method rule)
  rule('GET', '/api/analytics', ['reports.read'], 'View analytics'),
  rule('*', '/api/analytics', ['reports.export'], 'Any-method analytics fallback'),
  rule('GET', '/api/analytics/*', ['reports.read'], 'View analytics detail'),
  // Lookup / reference data
  rule('GET', '/api/lookup/*', ['settings.read'], 'View lookup data'),
  rule('POST', '/api/lookup/*', ['settings.write'], 'Modify lookup data'),
  // Training
  rule('GET', '/api/training/*', ['training.read'], 'View training'),
  rule('POST', '/api/training/*', ['training.write'], 'Create/modify training'),
  rule('DELETE', '/api/training/*', ['training.delete'], 'Delete training'),
  rule('GET', '/api/certs/*', ['training.read'], 'View certifications'),
  rule('POST', '/api/certs/*', ['training.write'], 'Modify certifications'),
  rule('GET', '/api/classes/*', ['training.read'], 'View classes'),
  rule('POST', '/api/classes/*', ['training.write'], 'Modify classes'),
  // Documents
  rule('GET', '/api/documents/*', ['documents.read'], 'View documents'),
  rule('POST', '/api/documents/*', ['documents.write'], 'Create/modify documents'),
  rule('POST', '/api/documents/translate', ['documents.translate'], 'Translate a document'),
  rule('POST', '/api/documents/publish', ['documents.publish'], 'Publish a document'),
  // AI
  rule('GET', '/api/ai/*', ['ai.use'], 'AI-assisted read'),
  rule('POST', '/api/ai/*', ['ai.use'], 'Use AI features'),
  rule('POST', '/api/ai/admin/*', ['ai.admin'], 'Administer AI'),
  // Competency
  rule('GET', '/api/competency/*', ['competency.read'], 'View competencies'),
  rule('POST', '/api/competency/*', ['competency.write'], 'Modify competencies'),
  // Assessments / exams / forms
  rule('GET', '/api/exams/*', ['assessments.read'], 'View exams'),
  rule('POST', '/api/exams/*', ['assessments.write'], 'Modify exams'),
  rule('GET', '/api/forms/*', ['assessments.read'], 'View forms'),
  rule('POST', '/api/forms/*', ['assessments.write'], 'Populate forms'),
  // Workflows / settings / admin
  rule('GET', '/api/workflows/*', ['settings.read'], 'View workflows'),
  rule('POST', '/api/workflows/*', ['settings.write'], 'Modify workflows'),
  rule('GET', '/api/settings', ['settings.read'], 'View settings'),
  rule('PUT', '/api/settings', ['settings.write'], 'Modify settings'),
  rule('*', '/api/admin/*', ['admin.full'], 'Administrative operations'),
  // HR / disciplinary / onboarding
  rule('GET', '/api/disciplinary/*', ['hr.read'], 'View disciplinary records'),
  rule('POST', '/api/disciplinary/*', ['hr.write'], 'Modify disciplinary records'),
  rule('GET', '/api/onboarding/*', ['hr.read'], 'View onboarding'),
  rule('POST', '/api/onboarding/*', ['hr.write'], 'Modify onboarding'),
  // Safety
  rule('GET', '/api/safety/*', ['safety.read'], 'View safety records'),
  rule('POST', '/api/safety/*', ['safety.write'], 'Modify safety records'),
  // PowerPoints / translator (document-family)
  rule('GET', '/api/powerpoints/*', ['documents.read'], 'View decks'),
  rule('POST', '/api/powerpoints/*', ['documents.write'], 'Develop decks'),
  rule('GET', '/api/translator/*', ['documents.read'], 'View translations'),
  rule('POST', '/api/translator/*', ['documents.translate'], 'Translate content'),
];

// Deep-frozen registry (array + each rule + each permissions array).
const ROUTE_PERMISSIONS = Object.freeze(
  RAW_RULES.map((r) => Object.freeze({ ...r, permissions: Object.freeze([...r.permissions]) })),
);

// ── pure helpers ────────────────────────────────────────────────────────────
function normalizeMethod(method) {
  return typeof method === 'string' ? method.trim().toUpperCase() : '';
}
function normalizePath(path) {
  if (typeof path !== 'string') return '';
  let p = path.split('?')[0].split('#')[0].trim();
  if (p === '') return '';
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}
function segments(p) { return p.split('/').filter((s) => s !== ''); }

// Match a pattern against a normalized path. Returns a specificity score
// (3 exact, 2 parameter, 1 wildcard) or null when there is no match.
function matchSpecificity(pattern, path) {
  const pat = segments(pattern);
  const tgt = segments(path);
  if (pat.length > 0 && pat[pat.length - 1] === '*') {
    const prefix = pat.slice(0, -1);
    if (tgt.length < prefix.length) return null;
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i].startsWith(':') ? tgt[i].length === 0 : prefix[i] !== tgt[i]) return null;
    }
    return 1;
  }
  if (pat.length !== tgt.length) return null;
  let hasParam = false;
  for (let i = 0; i < pat.length; i++) {
    if (pat[i].startsWith(':')) { if (tgt[i].length === 0) return null; hasParam = true; }
    else if (pat[i] !== tgt[i]) return null;
  }
  return hasParam ? 2 : 3;
}

function copyRule(r) {
  return { method: r.method, pathPattern: r.pathPattern, permissions: [...r.permissions], description: r.description, mode: r.mode };
}

// Return the best-matching rule (fresh copy) for method+path, or null. Precedence:
// path specificity (exact > param > wildcard) first, then method-specific > '*'.
function matchRoutePermission(method, path) {
  try {
    const m = normalizeMethod(method);
    const p = normalizePath(path);
    if (!p) return null;
    let best = null;
    let bestScore = -1;
    for (const r of ROUTE_PERMISSIONS) {
      if (r.method !== '*' && r.method !== m) continue;
      const spec = matchSpecificity(r.pathPattern, p);
      if (spec == null) continue;
      const score = spec * 10 + (r.method === m ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return best ? copyRule(best) : null;
  } catch {
    return null;
  }
}

// Resolve the report-only permission requirement for a request. Unknown route →
// safe default. Known → the matched rule (fresh copies throughout). Never throws.
function getRoutePermissions(method, path) {
  const rule = matchRoutePermission(method, path);
  if (!rule) return { permissions: [], mode: 'report', matched: false };
  return { permissions: [...rule.permissions], mode: rule.mode, matched: true, rule };
}

// A fresh array of fresh rule copies (never the frozen internals).
function listRoutePermissionRules() {
  return ROUTE_PERMISSIONS.map(copyRule);
}

module.exports = {
  ROUTE_PERMISSIONS,
  getRoutePermissions,
  matchRoutePermission,
  listRoutePermissionRules,
};
