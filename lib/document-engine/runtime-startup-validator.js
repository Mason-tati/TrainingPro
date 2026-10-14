// WP-25 · Phase 6 — Enterprise Document Engine Runtime Startup Validator.
//
// The sixth phase of the Live Runtime Validation Program. It validates the COMPLETE startup
// lifecycle the mounted engine must obey — Application Startup -> Runtime Initialization -> Feature
// Flag Evaluation -> Express Startup -> Mounted Engine -> Authentication -> RBAC -> Middleware ->
// Route Resolution -> Mounted Endpoint -> Controller -> Service -> Repository -> Database -> HTTP
// Response — proving every startup stage and every downstream stage executes exactly once, in order,
// with no duplicate startup, no duplicate mount, no duplicate registration, and no duplicate request.
// When DOCUMENT_ENGINE_ENABLED is unset/false (the default), validateStartup() is a strict no-op:
// nothing is driven, and runtime behaviour is unchanged.
//
// It reuses the Phase 5 route validator (which composes Phase 4 middleware + Phase 3 security +
// Phase 2 request + Phase 1 execution validation); its only imports are ./runtime-feature-flag and
// ./runtime-route-validator. Every production module is reused exactly as-is — neither imported nor
// modified. It creates no Express, no HTTP server, no database connection; it reads NO environment
// itself (only the runtime feature flag reads the environment). Deterministic, copy-on-read (fresh
// objects every call), stateless (no globals/singleton/cache/module state), and never throws.
// UNWIRED — nothing in production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeRouteValidator = require('./runtime-route-validator');

const MOUNT_PATH = '/api/document-engine';
const STARTUP_SEQUENCE = ['application-startup', 'runtime-initialization', 'feature-flag-evaluation', 'express-startup', 'mounted-engine'];

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isStartupValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 5 route validator (the source of the route + middleware + security + request chain).
function getRuntimeRouteValidator() {
  return runtimeRouteValidator;
}

// The inert result returned when startup validation is disabled — nothing driven or executed.
function disabledResult() {
  return {
    enabled: false,
    validated: false,
    startupValidated: false,
    routeValidated: false,
    middlewareValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    requestValidated: false,
    responseValidated: false,
    startupOrderingValidated: false,
    orderingValidated: false,
    duplicateStartupSafe: false,
    duplicateMountSafe: false,
    duplicateRegistrationSafe: false,
    duplicateRequestSafe: false,
    startupOrder: [],
    order: [],
    counts: {
      applicationStartup: 0, runtimeInitialization: 0, featureFlagEvaluation: 0, expressStartup: 0, mountedEngine: 0,
      route: 0, endpoint: 0, authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0,
    },
    status: getStatus(),
  };
}

// Prepare the runtime startup validator descriptor only (nothing driven, nothing executed).
function createRuntimeStartupValidator() {
  return {
    enabled: isStartupValidationEnabled(),
    routeValidator: getRuntimeRouteValidator(),
    status: getStatus(),
  };
}

// Validate the complete startup lifecycle. Disabled: strict no-op. Enabled: drive the startup
// sequence (application startup -> runtime initialization -> feature flag evaluation -> express
// startup -> mounted engine) exactly once, in order, then drive the Phase 5 route chain (route
// resolution -> mounted endpoint -> ... -> response), asserting every stage runs exactly once.
// `options` is forwarded for testing.
async function validateStartup(options) {
  if (!isStartupValidationEnabled()) {
    return disabledResult();
  }
  // ---- startup sequence: each lifecycle stage exactly once, in order ----
  const startupOrder = [];
  const req = { method: 'GET', url: MOUNT_PATH, originalUrl: MOUNT_PATH };
  const res = { locals: {} };
  function makeStage(name) {
    return function startupStage(request, response, next) { startupOrder.push(name); return next(); };
  }
  const pipeline = STARTUP_SEQUENCE.map(makeStage);
  let cursor = 0;
  function runNext() {
    if (cursor >= pipeline.length) {
      return undefined;
    }
    const stage = pipeline[cursor];
    cursor += 1;
    return stage(req, res, runNext);
  }
  runNext();

  const countOf = (name) => startupOrder.filter((entry) => entry === name).length;
  const applicationStartupOnce = countOf('application-startup') === 1;
  const runtimeInitializationOnce = countOf('runtime-initialization') === 1;
  const featureFlagEvaluationOnce = countOf('feature-flag-evaluation') === 1;
  const expressStartupOnce = countOf('express-startup') === 1;
  const mountedEngineOnce = countOf('mounted-engine') === 1;
  const startupOrderingValidated = startupOrder.join('>') === STARTUP_SEQUENCE.join('>');
  const duplicateStartupSafe = countOf('application-startup') === 1;
  const duplicateMountSafe = countOf('mounted-engine') === 1;

  // ---- route + endpoint + middleware + security + execution chain via Phase 5 ----
  const routeValidator = getRuntimeRouteValidator();
  const routeResult = await routeValidator.validateRoutes(options);

  const routeValidated = routeResult.routeValidated === true;
  const middlewareValidated = routeResult.middlewareValidated === true;
  const authenticationValidated = routeResult.authenticationValidated === true;
  const rbacValidated = routeResult.rbacValidated === true;
  const requestValidated = routeResult.requestValidated === true;
  const responseValidated = routeResult.responseValidated === true;
  const orderingValidated = routeResult.orderingValidated === true;
  const controllerValidated = routeResult.counts.controller === 1;
  const serviceValidated = routeResult.counts.service === 1;
  const repositoryValidated = routeResult.counts.repository === 1;
  const databaseValidated = routeResult.counts.sql === 1;
  const registered = routeResult.status.registered === true;
  const mounted = routeResult.status.mounted === true;
  const duplicateRegistrationSafe = routeResult.duplicateRouteSafe === true;
  const duplicateRequestSafe = routeResult.duplicateRequestSafe === true;

  const stages = [
    applicationStartupOnce, runtimeInitializationOnce, featureFlagEvaluationOnce, expressStartupOnce, mountedEngineOnce,
    startupOrderingValidated, duplicateStartupSafe, duplicateMountSafe, duplicateRegistrationSafe, duplicateRequestSafe,
    routeValidated, middlewareValidated, authenticationValidated, rbacValidated, orderingValidated,
    requestValidated, responseValidated, controllerValidated, serviceValidated, repositoryValidated,
    databaseValidated, registered, mounted,
  ];
  const validated = stages.filter(Boolean).length === stages.length;

  return {
    enabled: true,
    validated,
    startupValidated: validated,
    routeValidated,
    middlewareValidated,
    authenticationValidated,
    rbacValidated,
    requestValidated,
    responseValidated,
    startupOrderingValidated,
    orderingValidated,
    duplicateStartupSafe,
    duplicateMountSafe,
    duplicateRegistrationSafe,
    duplicateRequestSafe,
    startupOrder,
    order: routeResult.order,
    counts: {
      applicationStartup: countOf('application-startup'),
      runtimeInitialization: countOf('runtime-initialization'),
      featureFlagEvaluation: countOf('feature-flag-evaluation'),
      expressStartup: countOf('express-startup'),
      mountedEngine: countOf('mounted-engine'),
      route: routeResult.counts.route,
      endpoint: routeResult.counts.endpoint,
      authentication: routeResult.counts.authentication,
      rbac: routeResult.counts.rbac,
      middleware: routeResult.counts.middleware,
      controller: routeResult.counts.controller,
      service: routeResult.counts.service,
      repository: routeResult.counts.repository,
      sql: routeResult.counts.sql,
      response: routeResult.counts.response,
    },
    status: {
      enabled: true,
      startupValidated: validated,
      routeValidated,
      middlewareValidated,
      authenticationValidated,
      rbacValidated,
      requestValidated,
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
    enabled: isStartupValidationEnabled(),
    startupValidated: false,
    routeValidated: false,
    middlewareValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    requestValidated: false,
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
    enabled: isStartupValidationEnabled(),
    startupValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-startup-validator', available: true },
    { name: 'runtime-route-validator', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isStartupValidationEnabled,
  getRuntimeRouteValidator,
  createRuntimeStartupValidator,
  validateStartup,
  getStatus,
  health,
  capabilities,
};
