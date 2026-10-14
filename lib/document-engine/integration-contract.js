// WP-19 · E8 — Enterprise Pre-Mount Integration Contract (deterministic requirements).
//
// This module defines what must exist BEFORE the Enterprise Document Engine may be mounted into
// production. It inspects no runtime state, mounts nothing, and validates no Express — it simply
// returns the static integration requirements. Think of it as an executable contract. Its only
// import is the sibling ./mounting-report; it does NOT import Express, the server, an app, HTTP,
// the router, or mounting.js directly. Deterministic, pure, stateless, dependency-free,
// copy-on-read (fresh objects and arrays every call), never throws, no mutable globals, no
// singleton, no cache. UNWIRED — nothing in production imports it.
'use strict';

const report = require('./mounting-report');

// A fresh integration contract every call — readiness/mounted derived from the mounting report;
// the requires* flags are the static pre-mount obligations.
function getContract() {
  const rep = report.generateReport();
  return {
    ready: rep.ready,
    productionReady: rep.productionWired,
    mounted: rep.mounted,
    requiresExpressMount: true,
    requiresAuthentication: true,
    requiresAuthorization: true,
    requiresValidation: true,
    requiresAudit: true,
    requiresLogging: true,
    version: rep.version,
  };
}

// A fresh requirements list (fresh array + fresh entries) every call.
function getRequirements() {
  return [
    { name: 'Express mounting', required: true },
    { name: 'Authentication', required: true },
    { name: 'Authorization', required: true },
    { name: 'Validation', required: true },
    { name: 'Audit logging', required: true },
    { name: 'Production registration', required: true },
  ];
}

// A fresh deterministic summary every call.
function getSummary() {
  return { status: 'READY', production: 'NOT_INTEGRATED', safe: true };
}

// A fresh deterministic health descriptor every call.
function health() {
  return { ready: true, contractAvailable: true, productionIntegrated: false };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'contract', available: true },
    { name: 'requirements', available: true },
    { name: 'summary', available: true },
    { name: 'readiness', available: true },
  ];
}

module.exports = {
  getContract,
  getRequirements,
  getSummary,
  health,
  capabilities,
};
