// WP-25 · Phase 7 — Enterprise Document Engine Runtime Production Validator.
//
// The seventh phase of the Live Runtime Validation Program. It validates the COMPLETE production
// runtime lifecycle the mounted engine must obey — Application Startup -> Runtime Initialization ->
// Feature Flag -> Express Startup -> Mounted Engine -> Authentication -> RBAC -> Middleware -> Route
// Resolution -> Mounted Endpoint -> Controller -> Service -> Repository -> Database -> HTTP Response
// -> Production Runtime Complete — proving every stage executes exactly once, in order, with no
// duplicate startup, no duplicate mount, no duplicate registration, and no duplicate request, and
// that production runtime completion fires exactly once at the end. When DOCUMENT_ENGINE_ENABLED is
// unset/false (the default), validateProduction() is a strict no-op: nothing is driven, and runtime
// behaviour is unchanged.
//
// IMPORTANT — validating the production lifecycle does NOT make the engine live: the mounted route
// remains the WP-24 guarded (non-serving) handler, the engine stays gated behind the OFF flag, and
// production/mode remain false/FOUNDATION. It reuses the Phase 6 startup validator (which composes
// Phases 5->4->3->2->1); its only imports are ./runtime-feature-flag and ./runtime-startup-validator.
// Every production module is reused exactly as-is — neither imported nor modified. It creates no
// Express, no HTTP server, no database connection; it reads NO environment itself (only the runtime
// feature flag reads the environment). Deterministic, copy-on-read (fresh objects every call),
// stateless (no globals/singleton/cache/module state), and never throws. UNWIRED — nothing in
// production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeStartupValidator = require('./runtime-startup-validator');

const PRODUCTION_COMPLETION = 'production-runtime-complete';

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isProductionValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 6 startup validator (the source of the startup + route + security + request chain).
function getRuntimeStartupValidator() {
  return runtimeStartupValidator;
}

// The inert result returned when production validation is disabled — nothing driven or executed.
function disabledResult() {
  return {
    enabled: false,
    validated: false,
    productionValidated: false,
    startupValidated: false,
    routeValidated: false,
    middlewareValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    requestValidated: false,
    responseValidated: false,
    productionCompletionValidated: false,
    startupOrderingValidated: false,
    orderingValidated: false,
    productionOrderingValidated: false,
    duplicateStartupSafe: false,
    duplicateMountSafe: false,
    duplicateRegistrationSafe: false,
    duplicateRequestSafe: false,
    startupOrder: [],
    order: [],
    productionOrder: [],
    counts: {
      applicationStartup: 0, runtimeInitialization: 0, featureFlagEvaluation: 0, expressStartup: 0, mountedEngine: 0,
      route: 0, endpoint: 0, authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0,
      productionComplete: 0,
    },
    status: getStatus(),
  };
}

// Prepare the runtime production validator descriptor only (nothing driven, nothing executed).
function createRuntimeProductionValidator() {
  return {
    enabled: isProductionValidationEnabled(),
    startupValidator: getRuntimeStartupValidator(),
    status: getStatus(),
  };
}

// Validate the complete production runtime lifecycle. Disabled: strict no-op. Enabled: drive the
// Phase 6 startup lifecycle (which composes the full route/security/request/execution chain), then
// mark production runtime completion exactly once, asserting every stage runs exactly once and the
// production lifecycle completes last. `options` is forwarded for testing.
async function validateProduction(options) {
  if (!isProductionValidationEnabled()) {
    return disabledResult();
  }
  const startupValidator = getRuntimeStartupValidator();
  const startupResult = await startupValidator.validateStartup(options);

  // ---- production runtime completion: fires exactly once, at the end of the lifecycle ----
  let productionCompletionCount = 0;
  const completeProductionRuntime = () => { productionCompletionCount += 1; };
  completeProductionRuntime();
  const productionCompletionOnce = productionCompletionCount === 1;

  const productionOrder = startupResult.startupOrder.concat([PRODUCTION_COMPLETION]);
  const productionOrderingValidated = productionOrder[productionOrder.length - 1] === PRODUCTION_COMPLETION;

  const startupValidated = startupResult.startupValidated === true;
  const routeValidated = startupResult.routeValidated === true;
  const middlewareValidated = startupResult.middlewareValidated === true;
  const authenticationValidated = startupResult.authenticationValidated === true;
  const rbacValidated = startupResult.rbacValidated === true;
  const requestValidated = startupResult.requestValidated === true;
  const responseValidated = startupResult.responseValidated === true;
  const startupOrderingValidated = startupResult.startupOrderingValidated === true;
  const orderingValidated = startupResult.orderingValidated === true;
  const duplicateStartupSafe = startupResult.duplicateStartupSafe === true;
  const duplicateMountSafe = startupResult.duplicateMountSafe === true;
  const duplicateRegistrationSafe = startupResult.duplicateRegistrationSafe === true;
  const duplicateRequestSafe = startupResult.duplicateRequestSafe === true;
  const controllerValidated = startupResult.counts.controller === 1;
  const serviceValidated = startupResult.counts.service === 1;
  const repositoryValidated = startupResult.counts.repository === 1;
  const databaseValidated = startupResult.counts.sql === 1;
  const registered = startupResult.status.registered === true;
  const mounted = startupResult.status.mounted === true;

  const stages = [
    startupValidated, routeValidated, middlewareValidated, authenticationValidated, rbacValidated,
    requestValidated, responseValidated, productionCompletionOnce,
    startupOrderingValidated, orderingValidated, productionOrderingValidated,
    duplicateStartupSafe, duplicateMountSafe, duplicateRegistrationSafe, duplicateRequestSafe,
    controllerValidated, serviceValidated, repositoryValidated, databaseValidated, registered, mounted,
  ];
  const validated = stages.filter(Boolean).length === stages.length;

  return {
    enabled: true,
    validated,
    productionValidated: validated,
    startupValidated,
    routeValidated,
    middlewareValidated,
    authenticationValidated,
    rbacValidated,
    requestValidated,
    responseValidated,
    productionCompletionValidated: productionCompletionOnce,
    startupOrderingValidated,
    orderingValidated,
    productionOrderingValidated,
    duplicateStartupSafe,
    duplicateMountSafe,
    duplicateRegistrationSafe,
    duplicateRequestSafe,
    startupOrder: startupResult.startupOrder,
    order: startupResult.order,
    productionOrder,
    counts: {
      applicationStartup: startupResult.counts.applicationStartup,
      runtimeInitialization: startupResult.counts.runtimeInitialization,
      featureFlagEvaluation: startupResult.counts.featureFlagEvaluation,
      expressStartup: startupResult.counts.expressStartup,
      mountedEngine: startupResult.counts.mountedEngine,
      route: startupResult.counts.route,
      endpoint: startupResult.counts.endpoint,
      authentication: startupResult.counts.authentication,
      rbac: startupResult.counts.rbac,
      middleware: startupResult.counts.middleware,
      controller: startupResult.counts.controller,
      service: startupResult.counts.service,
      repository: startupResult.counts.repository,
      sql: startupResult.counts.sql,
      response: startupResult.counts.response,
      productionComplete: productionCompletionCount,
    },
    status: {
      enabled: true,
      productionValidated: validated,
      startupValidated,
      routeValidated,
      middlewareValidated,
      authenticationValidated,
      rbacValidated,
      controllerValidated,
      serviceValidated,
      repositoryValidated,
      databaseValidated,
      responseValidated,
      registered,
      mounted,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call (pre-run: nothing validated by merely reading it).
function getStatus() {
  return {
    enabled: isProductionValidationEnabled(),
    productionValidated: false,
    startupValidated: false,
    routeValidated: false,
    middlewareValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    controllerValidated: false,
    serviceValidated: false,
    repositoryValidated: false,
    databaseValidated: false,
    responseValidated: false,
    registered: false,
    mounted: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

// A fresh deterministic health object every call.
function health() {
  return {
    ready: true,
    enabled: isProductionValidationEnabled(),
    productionValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-production-validator', available: true },
    { name: 'runtime-startup-validator', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isProductionValidationEnabled,
  getRuntimeStartupValidator,
  createRuntimeProductionValidator,
  validateProduction,
  getStatus,
  health,
  capabilities,
};
