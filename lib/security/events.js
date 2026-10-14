// WP-13 · S7 — Security event logging alignment layer.
//
// Dependency-free wrappers over the existing structured logger that emit
// consistent SECURITY_* events with a strict metadata ALLOW-LIST. Any key not on
// the allow-list is discarded BEFORE the logger is called (defence in depth on
// top of the logger's own redaction) — so passwords, hashes, session ids,
// cookies, tokens, bodies, SQL, prompts, and PII can never reach a record. No DB,
// no network. Never throws. Uses the schema-valid `Authentication` module while
// preserving the active request correlation (requestId/actor/tenant).
'use strict';

const logger = require('../logger');
const requestContext = require('../request-context');

// The ONLY metadata keys allowed on a security event.
const ALLOWED_KEYS = new Set([
  'path', 'method', 'status', 'mode', 'attempts', 'limit', 'windowMs', 'blockMs',
  'enforced', 'username', 'action', 'severity', 'recommendation', 'kind', 'reason',
  'filename', 'mimeType', 'sizeBytes',
]);

// Keep only allow-listed keys; everything else (password, hash, cookie, prompt,
// body, sql, …) is dropped here, never handed to the logger.
function pickAllowed(metadata) {
  const out = {};
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    for (const [k, v] of Object.entries(metadata)) {
      if (ALLOWED_KEYS.has(k)) out[k] = v;
    }
  }
  return out;
}

// Emit a SECURITY_* event (module Authentication) with allow-listed metadata,
// preserving any active request context. Never throws.
function securityEvent(event, metadata) {
  try {
    const ctx = requestContext.get() || {};
    const safe = pickAllowed(metadata);
    requestContext.run({ ...ctx, module: 'Authentication' }, () => logger.warn(String(event), safe));
  } catch { /* security logging must never throw */ }
}

const loginThrottled = (metadata) => securityEvent('SECURITY_LOGIN_THROTTLED', metadata);
const defaultCredential = (metadata) => securityEvent('SECURITY_DEFAULT_CREDENTIAL', metadata);
const uploadRejected = (metadata) => securityEvent('SECURITY_UPLOAD_REJECTED', metadata);
const rateLimit = (metadata) => securityEvent('SECURITY_RATE_LIMIT', metadata);

module.exports = {
  securityEvent,
  loginThrottled,
  defaultCredential,
  uploadRejected,
  rateLimit,
  ALLOWED_KEYS,
};
