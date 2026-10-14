// WP-08 · L2 — Request context service (AsyncLocalStorage).
//
// Provides per-request context (requestId, actor, tenantId, module, startTime)
// with no global mutable state — the store lives entirely inside AsyncLocalStorage
// and is isolated per request, including across async boundaries. This module only
// stores/reads context; it performs NO logging, timing, auth, or I/O (those are
// later WP-08 commits). Dependency-free (Node core only).
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

// Run `callback` with `context` bound for the duration of the async call tree.
function run(context, callback) {
  return als.run(context || {}, callback);
}

// The current context object, or null when running outside any request.
function get() {
  return als.getStore() || null;
}

function getRequestId() {
  const s = get();
  return s ? s.requestId : null;
}

function getActor() {
  const s = get();
  return s ? s.actor : null;
}

function getTenantId() {
  const s = get();
  return s ? s.tenantId : null;
}

function getModule() {
  const s = get();
  return s ? s.module : null;
}

// Update a value on the CURRENT context (used later by auth middleware to set the
// real actor/tenant). No-op when there is no active context.
function set(key, value) {
  const s = get();
  if (s) s[key] = value;
}

module.exports = { run, get, getRequestId, getActor, getTenantId, getModule, set };
