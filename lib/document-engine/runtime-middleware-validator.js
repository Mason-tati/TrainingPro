// WP-25 · Phase 4 — Enterprise Document Engine Runtime Middleware Validator.
//
// The fourth phase of the Live Runtime Validation Program. It validates the COMPLETE runtime
// middleware pipeline the mounted engine must obey — HTTP Request -> Authentication -> RBAC ->
// Middleware -> Mounted Route -> Controller -> Service -> Repository -> Database -> HTTP Response —
// from the MIDDLEWARE perspective: every middleware executes exactly once, in order, with no
// duplicate middleware execution and no duplicate request, and every downstream stage executes
// exactly once. When DOCUMENT_ENGINE_ENABLED is unset/false (the default), validateMiddleware() is a
// strict no-op: nothing is driven, nothing executes, and runtime behaviour is unchanged.
//
// It reuses the Phase 3 authentication validator (which drives the authentication -> RBAC ->
// middleware pipeline and composes the Phase 2 request + Phase 1 execution chain); its only imports
// are ./runtime-feature-flag and ./runtime-authentication-validator. The production middleware and
// auth/RBAC modules are neither imported nor modified — they remain the production source of truth,
// reused exactly as-is. It creates no Express, no HTTP server, no database connection; it reads NO
// environment itself (only the runtime feature flag reads the environment). Deterministic,
// copy-on-read (fresh objects every call), stateless (no globals/singleton/cache/module state), and
// never throws. UNWIRED — nothing in production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeAuthenticationValidator = require('./runtime-authentication-validator');

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isMiddlewareValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 3 authentication validator (the source of the security + request + execution chain).
function getRuntimeAuthenticationValidator() {
  return runtimeAuthenticationValidator;
}

// The inert result returned when middleware validation is disabled — nothing driven or executed.
function disabledResult() {
  return {
    enabled: false,
    validated: false,
    middlewareValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    requestValidated: false,
    responseValidated: false,
    orderingValidated: false,
    duplicateMiddlewareSafe: false,
    duplicateRequestSafe: false,
    order: [],
    counts: { authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0 },
    status: getStatus(),
  };
}

// Prepare the runtime middleware validator descriptor only (nothing driven, nothing executed).
function createRuntimeMiddlewareValidator() {
  return {
    enabled: isMiddlewareValidationEnabled(),
    authenticationValidator: getRuntimeAuthenticationValidator(),
    status: getStatus(),
  };
}

// Validate the complete runtime middleware pipeline. Disabled: strict no-op. Enabled: drive the
// Phase 3 security chain (authentication -> RBAC -> middleware -> mounted route -> controller ->
// service -> repository -> database -> response) and assert every middleware and every downstream
// stage executed exactly once, in order, with no duplicate middleware/request. `options` forwarded.
async function validateMiddleware(options) {
  if (!isMiddlewareValidationEnabled()) {
    return disabledResult();
  }
  const authValidator = getRuntimeAuthenticationValidator();
  const authResult = await authValidator.validateAuthentication(options);

  const middlewareValidated = authResult.counts.middleware === 1;
  const authenticationValidated = authResult.counts.authentication === 1;
  const rbacValidated = authResult.counts.rbac === 1;
  const orderingValidated = authResult.orderingValidated === true;
  const duplicateMiddlewareSafe = authResult.duplicateMiddlewareSafe === true;
  const duplicateRequestSafe = authResult.duplicateRequestSafe === true;
  const requestValidated = authResult.requestValidated === true;
  const responseValidated = authResult.responseValidated === true;
  const controllerValidated = authResult.counts.controller === 1;
  const serviceValidated = authResult.counts.service === 1;
  const repositoryValidated = authResult.counts.repository === 1;
  const databaseValidated = authResult.counts.sql === 1;
  const registered = authResult.status.registered === true;
  const mounted = authResult.status.mounted === true;

  const stages = [
    middlewareValidated, authenticationValidated, rbacValidated, orderingValidated,
    duplicateMiddlewareSafe, duplicateRequestSafe, requestValidated, responseValidated,
    controllerValidated, serviceValidated, repositoryValidated, databaseValidated,
    registered, mounted,
  ];
  const validated = stages.filter(Boolean).length === stages.length;

  return {
    enabled: true,
    validated,
    middlewareValidated,
    authenticationValidated,
    rbacValidated,
    requestValidated,
    responseValidated,
    orderingValidated,
    duplicateMiddlewareSafe,
    duplicateRequestSafe,
    order: authResult.order,
    counts: {
      authentication: authResult.counts.authentication,
      rbac: authResult.counts.rbac,
      middleware: authResult.counts.middleware,
      controller: authResult.counts.controller,
      service: authResult.counts.service,
      repository: authResult.counts.repository,
      sql: authResult.counts.sql,
      response: authResult.counts.response,
    },
    status: {
      enabled: true,
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
    enabled: isMiddlewareValidationEnabled(),
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
    enabled: isMiddlewareValidationEnabled(),
    middlewareValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-middleware-validator', available: true },
    { name: 'runtime-authentication-validator', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isMiddlewareValidationEnabled,
  getRuntimeAuthenticationValidator,
  createRuntimeMiddlewareValidator,
  validateMiddleware,
  getStatus,
  health,
  capabilities,
};
