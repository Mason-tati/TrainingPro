// WP-19 · E6 — Enterprise Route Mounting Readiness (metadata only).
//
// This module DOES NOT mount anything. It only exposes the metadata describing how the isolated
// router would eventually be mounted. It imports nothing beyond the sibling router; it does NOT
// import Express, the server, or an app; it creates no application, performs no route
// registration, starts no server, registers no middleware, and exposes no listeners.
// Deterministic, pure, stateless, dependency-free (its only import is ./routes), copy-on-read
// (fresh data objects), never throws, no mutable globals, no singleton, no cache. UNWIRED —
// nothing in production imports it.
'use strict';

const router = require('./routes');

const MOUNT_PATH = '/api/document-engine';
const VERSION = 1;

// Returns the actual router (so it can eventually be mounted) — nothing more.
function getRouter() { return router; }

// The path at which the router would eventually be mounted.
function getMountPath() { return MOUNT_PATH; }

// A fresh configuration descriptor every call (the router reference is intentionally shared so
// it remains mountable; all data fields are fresh).
function getConfiguration() {
  return { mountPath: MOUNT_PATH, router, middleware: [], registered: false, version: VERSION };
}

// Ready to be mounted (NOT that it is mounted).
function isReady() { return true; }

// A fresh deterministic health descriptor every call.
function health() {
  return { ready: true, mounted: false, routerAvailable: typeof router === 'function' };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'router', available: true },
    { name: 'mountPath', available: true },
    { name: 'configuration', available: true },
    { name: 'readiness', available: true },
  ];
}

module.exports = {
  getRouter,
  getMountPath,
  getConfiguration,
  isReady,
  health,
  capabilities,
};
