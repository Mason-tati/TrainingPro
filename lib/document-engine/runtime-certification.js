// WP-25 · Phase 8 — Enterprise Document Engine Runtime Certification (FINAL phase of WP-25).
//
// The Enterprise Runtime Certification phase. It certifies the complete Enterprise Document Engine
// runtime by COMPOSING the already-approved Phase 7 runtime production validator — it adds NO new
// validation logic of its own. Certification proves the entire runtime lifecycle has already been
// validated end to end — Application Startup -> Runtime Initialization -> Feature Flag Evaluation ->
// Express Startup -> Mounted Engine -> Authentication -> RBAC -> Middleware -> Route Resolution ->
// Mounted Endpoint -> Controller -> Service -> Repository -> Database -> HTTP Response -> Production
// Runtime Complete — with every stage exactly once, correctly ordered, and duplicate-free.
//
// IMPORTANT — certification does NOT activate production: it never mounts, routes, executes a
// controller, runs SQL/CRUD, writes files, creates an HTTP server or Express object, and it keeps
// production=false / mode=FOUNDATION. When DOCUMENT_ENGINE_ENABLED is unset/false (the default),
// certifyRuntime() is a strict no-op. Its only imports are ./runtime-feature-flag and
// ./runtime-production-validator; it reads NO environment itself (only the runtime feature flag reads
// the environment). Stateless, deterministic, copy-on-read (fresh objects every call), never throws,
// additive only. UNWIRED — nothing in production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeProductionValidator = require('./runtime-production-validator');

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isCertificationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 7 runtime production validator (the sole source of validation — no duplication).
function getRuntimeProductionValidator() {
  return runtimeProductionValidator;
}

// The inert result returned when certification is disabled — nothing validated, engine gated.
function disabledResult() {
  return {
    enabled: false,
    certified: false,
    startupValidated: false,
    runtimeValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    middlewareValidated: false,
    routeValidated: false,
    requestValidated: false,
    executionValidated: false,
    productionValidated: false,
    exactlyOnceValidated: false,
    orderingValidated: false,
    duplicateSafe: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// Prepare the runtime certification descriptor only (nothing validated, nothing executed).
function createRuntimeCertification() {
  return {
    enabled: isCertificationEnabled(),
    productionValidator: getRuntimeProductionValidator(),
    status: getStatus(),
  };
}

// Certify the complete runtime by composing the Phase 7 production validation. Disabled: strict
// no-op. Enabled: run runtime-production-validator.validateProduction() once and certify that every
// lifecycle stage was validated, executed exactly once, correctly ordered, and duplicate-free. Never
// activates production (production stays false, mode stays FOUNDATION). `options` is forwarded.
async function certifyRuntime(options) {
  if (!isCertificationEnabled()) {
    return disabledResult();
  }
  const productionValidator = getRuntimeProductionValidator();
  const prod = await productionValidator.validateProduction(options);

  const startupValidated = prod.startupValidated === true;
  const runtimeValidated = prod.validated === true;
  const authenticationValidated = prod.authenticationValidated === true;
  const rbacValidated = prod.rbacValidated === true;
  const middlewareValidated = prod.middlewareValidated === true;
  const routeValidated = prod.routeValidated === true;
  const requestValidated = prod.requestValidated === true;
  const productionValidated = prod.productionValidated === true;

  const executionValidated = [prod.counts.controller, prod.counts.service, prod.counts.repository, prod.counts.sql]
    .filter((n) => n === 1).length === 4;

  const countValues = Object.values(prod.counts);
  const exactlyOnceValidated = countValues.filter((n) => n === 1).length === countValues.length;

  const orderingValidated = [prod.startupOrderingValidated, prod.orderingValidated, prod.productionOrderingValidated]
    .filter(Boolean).length === 3;

  const duplicateSafe = [prod.duplicateStartupSafe, prod.duplicateMountSafe, prod.duplicateRegistrationSafe, prod.duplicateRequestSafe]
    .filter(Boolean).length === 4;

  const certFlags = [
    startupValidated, runtimeValidated, authenticationValidated, rbacValidated, middlewareValidated,
    routeValidated, requestValidated, executionValidated, productionValidated,
    exactlyOnceValidated, orderingValidated, duplicateSafe,
  ];
  const certified = certFlags.filter(Boolean).length === certFlags.length;

  return {
    enabled: true,
    certified,
    startupValidated,
    runtimeValidated,
    authenticationValidated,
    rbacValidated,
    middlewareValidated,
    routeValidated,
    requestValidated,
    executionValidated,
    productionValidated,
    exactlyOnceValidated,
    orderingValidated,
    duplicateSafe,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic status object every call (pre-run: nothing certified by merely reading it).
function getStatus() {
  return {
    enabled: isCertificationEnabled(),
    certified: false,
    startupValidated: false,
    runtimeValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    middlewareValidated: false,
    routeValidated: false,
    requestValidated: false,
    executionValidated: false,
    productionValidated: false,
    exactlyOnceValidated: false,
    orderingValidated: false,
    duplicateSafe: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call. `certified` is false at rest — certification is
// established only by running certifyRuntime(), not by probing health.
function health() {
  return {
    healthy: true,
    certified: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic capability list every call (exactly four entries).
function capabilities() {
  return [
    { name: 'Runtime Certification', available: true },
    { name: 'End-to-End Validation', available: true },
    { name: 'Production Readiness Certification', available: true },
    { name: 'Runtime Safety Verification', available: true },
  ];
}

module.exports = {
  isCertificationEnabled,
  getRuntimeProductionValidator,
  createRuntimeCertification,
  certifyRuntime,
  getStatus,
  health,
  capabilities,
};
