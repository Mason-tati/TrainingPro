// WP-13 · S3 — Login rate limiting (dependency-free, in-memory).
//
// A report-only-by-default login throttle for POST /api/auth/login. It NEVER
// blocks unless enforcement is explicitly enabled (config.rateLimit.RATE_LIMIT_
// ENFORCE === true), and it fails OPEN (calls next()) on any internal error, so
// it can never lock users out by accident. No database, no external store, no
// network. It logs only allow-listed operational metadata — never usernames,
// passwords, request bodies, cookies, session ids, tokens, or raw IPs.
'use strict';

const crypto = require('node:crypto');
const logger = require('../logger');

// ── in-memory per-key state (module-scoped; reset via __reset in tests) ──────
// key → { count, windowStart, blockedUntil }
const store = new Map();

// Injectable clock so tests can deterministically advance time (test seam only).
let clock = () => Date.now();

// Derive an opaque per-caller key from IP + username and HASH it, so neither the
// raw IP nor the raw username is ever retained in memory or logged.
function deriveKey(req) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
  const username = (req && req.body && typeof req.body.username === 'string') ? req.body.username : '';
  return crypto.createHash('sha256').update(`${ip}|${username}`).digest('hex').slice(0, 16);
}

// Emit one metadata-only SECURITY_LOGIN_THROTTLED event. Only the allow-listed
// operational fields are passed — never identity/secret/body values. Fully
// fenced: logging must never affect the limiter.
function emitThrottle(meta) {
  try {
    logger.warn('SECURITY_LOGIN_THROTTLED', {
      path: '/api/auth/login',
      method: 'POST',
      status: meta.enforced ? 429 : 200,
      mode: meta.enforced ? 'enforce' : 'report',
      attempts: meta.attempts,
      limit: meta.limit,
      windowMs: meta.windowMs,
      blockMs: meta.blockMs,
      enforced: meta.enforced,
    });
  } catch { /* logging must never affect the limiter */ }
}

const BLOCK_BODY = { error: 'Too many login attempts. Please try again later.' };

// Middleware factory. `config` is the S1 security config object.
function createLoginRateLimiter(config) {
  const cfg = config.rateLimit; // captured once; values are resolved at load time
  return function loginRateLimiter(req, res, next) {
    try {
      const now = clock();
      const enforced = cfg.RATE_LIMIT_ENFORCE === true;
      const max = cfg.RATE_LIMIT_LOGIN_MAX_ATTEMPTS;
      const windowMs = cfg.RATE_LIMIT_LOGIN_WINDOW_MS;
      const blockMs = cfg.RATE_LIMIT_LOGIN_BLOCK_MS;
      const key = deriveKey(req);

      let e = store.get(key);
      // Expire a lapsed block, then a lapsed window → start fresh.
      if (e && e.blockedUntil && now >= e.blockedUntil) e = undefined;
      if (e && !e.blockedUntil && now - e.windowStart >= windowMs) e = undefined;
      if (!e) { e = { count: 0, windowStart: now, blockedUntil: 0 }; store.set(key, e); }

      const meta = { attempts: e.count, limit: max, windowMs, blockMs, enforced };

      // Already blocked within the block window.
      if (e.blockedUntil && now < e.blockedUntil) {
        emitThrottle({ ...meta, attempts: e.count });
        if (enforced) return res.status(429).json(BLOCK_BODY);
        return next();
      }

      // Count this attempt; trip the block when the threshold is exceeded.
      e.count += 1;
      if (e.count > max) {
        e.blockedUntil = now + blockMs;
        emitThrottle({ ...meta, attempts: e.count });
        if (enforced) return res.status(429).json(BLOCK_BODY);
        return next();
      }
      return next();
    } catch {
      return next(); // FAIL OPEN — never lock anyone out on an internal error
    }
  };
}

module.exports = { createLoginRateLimiter };

// ── internal / testing seams (NOT wired through server.js) ───────────────────
module.exports.__reset = () => { store.clear(); };
module.exports.__setClock = (fn) => { clock = typeof fn === 'function' ? fn : (() => Date.now()); };
module.exports.__getState = () => ({ size: store.size, entries: [...store.values()].map((e) => ({ ...e })) });
