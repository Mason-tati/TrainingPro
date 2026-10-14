// WP-14 · A4 — Report-only authorization middleware (RBAC foundation).
//
// Evaluates authorization and records an ADVISORY result in request-context for a
// FUTURE enforcement layer. It is strictly report-only: it ALWAYS calls next(),
// NEVER returns 401/403, never throws, never mutates req/res/session/body. Built
// on the A1/A2 helpers. No logging here (no new log fields); no route consumes it.
'use strict';

const requestContext = require('../request-context');
const logger = require('../logger'); // WP-14 A7 — advisory audit event
const { resolveUserPermissions, resolveUserRoles } = require('./user-permissions');
const { isKnownPermission } = require('./access-control');
const { getRoutePermissions } = require('./route-permissions'); // WP-14 A6 — route→permission lookup

// Normalize the required-permissions input (string | array | null | undefined)
// into a sorted, unique list of non-blank permission id strings.
function normalizeRequired(requiredPermissions) {
  const raw = typeof requiredPermissions === 'string'
    ? [requiredPermissions]
    : (Array.isArray(requiredPermissions) ? requiredPermissions : []);
  const set = new Set();
  for (const p of raw) {
    if (typeof p === 'string' && p.trim() !== '') set.add(p.trim());
  }
  return [...set].sort();
}

// Pure evaluation. Returns { authorized, requiredPermissions, evaluatedPermissions,
// missingPermissions } — all arrays sorted, unique, and fresh copies. No required
// permissions → authorized true. Unknown permission → treated as missing. Unknown
// user → no permissions → authorized false (when something is required). Never throws.
function evaluateAuthorization(user, requiredPermissions) {
  const required = normalizeRequired(requiredPermissions);
  const evaluated = resolveUserPermissions(user); // [] for unknown/empty user; sorted, fresh
  const missing = required.filter((p) => !isKnownPermission(p) || !evaluated.includes(p)).sort();
  return {
    authorized: missing.length === 0,
    requiredPermissions: [...required],
    evaluatedPermissions: [...evaluated],
    missingPermissions: [...missing],
  };
}

// WP-14 A6 — build the report-only authorization report for a request: look up the
// route's future required permissions (A5 registry) and evaluate the session user
// (anonymous → empty user) against them. Pure/read-only: never mutates req, session,
// body, or the registry; never throws. The query string is stripped from the path.
function buildAuthorizationReport(req) {
  const method = req && req.method;
  const rawPath = req && (req.path || req.originalUrl || '');
  const reqPath = String(rawPath).split('?')[0];
  const route = getRoutePermissions(method, reqPath); // { permissions, mode, matched, rule? }
  const user = req && req.session ? req.session.user : null;
  const evaluation = evaluateAuthorization(user, route.permissions);
  return {
    authorized: evaluation.authorized,
    requiredPermissions: evaluation.requiredPermissions,
    evaluatedPermissions: evaluation.evaluatedPermissions,
    missingPermissions: evaluation.missingPermissions,
    matchedRoutePermission: route.matched,
    routePermissionMode: route.mode,
    routePermissionRule: route.matched ? route.rule : null,
  };
}

// WP-14 A7 — emit ONE advisory AUTHORIZATION_REPORT event, but ONLY when the
// route matched a registry rule. Count-only metadata (no permission names, no
// roles, no usernames, no session/cookies/tokens/body). The event is emitted with
// module `Authentication` and requestId correlation, but the authenticated actor
// is intentionally EXCLUDED (actor defaults to `anonymous`) per the allow-list.
// Fully fenced: a logger failure never affects the request. Report-only.
function emitAuthorizationReport(req, report) {
  try {
    if (!report || report.matchedRoutePermission !== true) return; // unmatched → emit nothing
    const rawPath = req && (req.path || req.originalUrl || '');
    const reqPath = String(rawPath).split('?')[0];
    const user = req && req.session ? req.session.user : null;
    const roleCount = resolveUserRoles(user).length;
    const ctx = requestContext.get() || {};
    requestContext.run({ requestId: ctx.requestId, module: 'Authentication' }, () =>
      logger.info('AUTHORIZATION_REPORT', {
        method: (req && typeof req.method === 'string') ? req.method : '',
        path: reqPath,
        matchedRoute: true,
        authorized: report.authorized,
        requiredPermissionCount: report.requiredPermissions.length,
        evaluatedPermissionCount: report.evaluatedPermissions.length,
        missingPermissionCount: report.missingPermissions.length,
        mode: report.routePermissionMode,
        roleCount,
      }));
  } catch { /* audit logging must never affect the request */ }
}

// Global initialiser middleware: computes the report-only authorization report
// for every request, stores it in request-context, and emits the advisory audit
// event for matched routes. NEVER denies/mutates/throws; always calls next().
function initAuthorizationContext(req, res, next) {
  try {
    const report = buildAuthorizationReport(req);
    requestContext.set('authorization', report);
    emitAuthorizationReport(req, report);
  } catch { /* report-only */ }
  return next();
}

// Route-level authorizer factory (report-only). Evaluates `requiredPermissions`
// against the session user and stores the advisory result in request-context.
// NEVER denies/mutates/throws. `options` is reserved for a future enforcement WP.
function authorize(requiredPermissions, options) { // eslint-disable-line no-unused-vars
  return function authorizeMiddleware(req, res, next) {
    try {
      const user = req && req.session ? req.session.user : null;
      requestContext.set('authorization', evaluateAuthorization(user, requiredPermissions));
    } catch { /* report-only: never affect the request */ }
    return next();
  };
}

module.exports = { authorize, evaluateAuthorization, initAuthorizationContext, buildAuthorizationReport, emitAuthorizationReport };
