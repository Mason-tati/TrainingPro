// WP-07 · C10 — TEST-ONLY outbound network guard.
// Blocks any outbound HTTP/HTTPS/fetch to non-local hosts so no test can make a
// real Anthropic/OpenAI/SMTP/API call. Localhost/loopback is allowed so the
// in-process API harness (http://127.0.0.1:<port>) keeps working.
//
// This module is loaded via `node --require` for the whole suite AND required at
// the top of tests/unit/ai.test.js. It NEVER runs in production (it lives under
// tests/ and is only referenced by test scripts/files). Idempotent.
'use strict';
const http = require('node:http');
const https = require('node:https');

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '']);

function isLocalHost(h) {
  if (!h) return true;
  const host = String(h).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return LOCAL.has(host);
}

function hostFromArgs(args) {
  try {
    const a = args[0];
    if (typeof a === 'string') return new URL(a).hostname;
    if (a instanceof URL) return a.hostname;
    if (a && typeof a === 'object') return a.hostname || a.host || '';
  } catch { /* fall through */ }
  return '';
}

function wrap(orig, ctx, label) {
  return function guarded(...args) {
    const host = hostFromArgs(args);
    if (!isLocalHost(host)) {
      throw new Error(`[network-guard] Outbound ${label} to "${host}" is blocked during tests (WP-07 C10). Use a stub/mock instead.`);
    }
    return orig.apply(ctx, args);
  };
}

if (!globalThis.__NETWORK_GUARD_ACTIVE__) {
  http.request = wrap(http.request, http, 'http.request');
  http.get = wrap(http.get, http, 'http.get');
  https.request = wrap(https.request, https, 'https.request');
  https.get = wrap(https.get, https, 'https.get');

  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let host = '';
      try {
        const url = typeof input === 'string' ? new URL(input)
          : input instanceof URL ? input
          : input && input.url ? new URL(input.url) : null;
        host = url ? url.hostname : '';
      } catch { /* ignore */ }
      if (!isLocalHost(host)) {
        throw new Error(`[network-guard] Outbound fetch to "${host}" is blocked during tests (WP-07 C10). Use a stub/mock instead.`);
      }
      return origFetch.call(this, input, init);
    };
  }

  globalThis.__NETWORK_GUARD_ACTIVE__ = true;
}

module.exports = { isLocalHost };
