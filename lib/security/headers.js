// WP-13 · S5 — Security headers + conservative same-origin CORS (foundation).
//
// Dependency-free middleware. No Helmet, no external package, no DB, no network,
// no logging, no request/response BODY access. Every security header is OPT-IN via
// the S1 config and OFF by default, so default production behaviour is unchanged.
// CSP is emitted REPORT-ONLY only. CORS is same-origin only — never a wildcard and
// never cross-origin credentials — and only acts when a matching Origin header is
// present, so requests without an Origin (the overwhelming default) are untouched.
'use strict';

// Conservative, SPA-safe report-only policy (kept non-breaking for the existing
// inline scripts/styles the app already ships).
const CSP_REPORT_ONLY_VALUE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

// Resolve the request's own origin and return the Origin header IFF it exactly
// matches (same-origin). Cross-origin or missing → null. X-Forwarded-Proto is
// honoured only when trust proxy is enabled (else req.protocol / http).
function sameOriginEcho(req, config) {
  const origin = req.headers && req.headers.origin;
  const host = req.headers && req.headers.host;
  if (!origin || !host) return null;
  let proto = req.protocol || 'http';
  if (config.proxy.TRUST_PROXY === true) {
    const xfp = req.headers['x-forwarded-proto'];
    if (xfp) proto = String(xfp).split(',')[0].trim();
  }
  return origin === `${proto}://${host}` ? origin : null;
}

// Middleware factory. `config` is the S1 security config object.
function createSecurityHeaders(config) {
  const h = config.headers;
  return function securityHeaders(req, res, next) {
    try {
      // ── CORS — same-origin only, never wildcard, never cross-origin creds ──
      const echo = sameOriginEcho(req, config);
      if (echo) {
        res.setHeader('Access-Control-Allow-Origin', echo);
        if (typeof res.vary === 'function') res.vary('Origin'); else res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Access-Control-Max-Age', '600');
          return res.status(204).end();
        }
      }

      // ── Static security response headers (opt-in) ──
      if (h.ENABLE_SECURITY_HEADERS === true) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      }

      // ── HSTS (opt-in, independent) ──
      if (h.ENABLE_HSTS === true) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      }

      // ── CSP — REPORT-ONLY only (never enforcing in S5) ──
      if (h.ENABLE_CSP === true && h.CSP_REPORT_ONLY === true) {
        res.setHeader('Content-Security-Policy-Report-Only', CSP_REPORT_ONLY_VALUE);
      }

      return next();
    } catch {
      return next(); // headers/CORS must never break the response pipeline
    }
  };
}

module.exports = { createSecurityHeaders, CSP_REPORT_ONLY_VALUE };
