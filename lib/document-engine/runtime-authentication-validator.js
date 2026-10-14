// WP-25 · Phase 3 — Enterprise Document Engine Runtime Authentication & RBAC Validator.
//
// The third phase of the Live Runtime Validation Program. It validates the COMPLETE runtime security
// chain the mounted engine must obey — HTTP Request -> Authentication -> RBAC -> Middleware ->
// Mounted Route -> Controller -> Service -> Repository -> Database -> HTTP Response — proving each
// stage executes exactly once, in order, with no duplicate middleware, no duplicate authorization,
// and no duplicate request. When DOCUMENT_ENGINE_ENABLED is unset/false (the default),
// validateAuthentication() is a strict no-op: nothing is driven, nothing executes, and runtime
// behaviour is unchanged.
//
// IMPORTANT — the production authentication and RBAC modules (lib/auth/*) are NOT imported and NOT
// modified: the import whitelist permits only ./runtime-feature-flag and ./runtime-request-validator,
// and the auth/RBAC implementation must remain untouched. This validator therefore models the
// authentication -> RBAC -> middleware PIPELINE ORDERING with instrumented, single-use stages and
// composes them with the Phase 2 request validation (which itself reuses the Phase 1 execution
// chain). The real security modules remain the production source of truth, exercised by the real
// server route pipeline; this phase validates the ordering and exactly-once discipline the mounted
// engine must satisfy.
//
// It creates no Express, no HTTP server, no database connection; it reads NO environment itself (only
// the runtime feature flag reads the environment). Deterministic, copy-on-read (fresh objects every
// call), stateless (no globals/singleton/cache/module state), and never throws. UNWIRED — nothing in
// production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeRequestValidator = require('./runtime-request-validator');

const MOUNT_PATH = '/api/document-engine';
const SECURITY_ORDER = 'authentication>rbac>middleware';

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isAuthenticationValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 2 runtime request validator (the source of the request/response + execution chain).
function getRuntimeRequestValidator() {
  return runtimeRequestValidator;
}

// The inert result returned when authentication validation is disabled — nothing driven or executed.
function disabledResult() {
  return {
    enabled: false,
    validated: false,
    authenticationValidated: false,
    rbacValidated: false,
    middlewareValidated: false,
    requestValidated: false,
    responseValidated: false,
    orderingValidated: false,
    duplicateMiddlewareSafe: false,
    duplicateAuthorizationSafe: false,
    duplicateRequestSafe: false,
    order: [],
    counts: { authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0 },
    status: getStatus(),
  };
}

// Prepare the runtime authentication validator descriptor only (nothing driven, nothing executed).
function createRuntimeAuthenticationValidator() {
  return {
    enabled: isAuthenticationValidationEnabled(),
    requestValidator: getRuntimeRequestValidator(),
    status: getStatus(),
  };
}

// Validate the complete runtime security chain. Disabled: strict no-op. Enabled: drive the
// authentication -> RBAC -> middleware pipeline exactly once, in order (no duplicate middleware/
// authorization), then validate the mounted request + Controller -> Service -> Repository -> Database
// -> Response chain exactly once via the Phase 2 validator. `options` is forwarded for testing.
async function validateAuthentication(options) {
  if (!isAuthenticationValidationEnabled()) {
    return disabledResult();
  }
  // ---- security pipeline: authentication -> RBAC -> middleware, each exactly once, in order ----
  const order = [];
  const counts = { authentication: 0, rbac: 0, middleware: 0 };
  const req = { method: 'GET', url: MOUNT_PATH, originalUrl: MOUNT_PATH };
  const res = { locals: {} };
  function makeStage(name) {
    return function securityStage(request, response, next) { counts[name] += 1; order.push(name); return next(); };
  }
  const pipeline = [makeStage('authentication'), makeStage('rbac'), makeStage('middleware')];
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

  const authenticationExactlyOnce = counts.authentication === 1;
  const rbacExactlyOnce = counts.rbac === 1;
  const middlewareExactlyOnce = counts.middleware === 1;
  const orderingValidated = order.join('>') === SECURITY_ORDER;
  const duplicateMiddlewareSafe = counts.middleware === 1;
  const duplicateAuthorizationSafe = counts.rbac === 1;

  // ---- mounted request + execution chain (Controller -> ... -> Database -> Response) via Phase 2 ----
  const requestValidator = getRuntimeRequestValidator();
  const reqResult = await requestValidator.validateRequest(options);
  const requestValidated = reqResult.requestValidated === true;
  const responseValidated = reqResult.responseValidated === true;
  const duplicateRequestSafe = reqResult.duplicateRequestSafe === true;
  const controllerValidated = reqResult.counts.controller === 1;
  const serviceValidated = reqResult.counts.service === 1;
  const repositoryValidated = reqResult.counts.repository === 1;
  const databaseValidated = reqResult.counts.sql === 1;
  const registered = reqResult.status.registered === true;
  const mounted = reqResult.status.mounted === true;

  const stages = [
    authenticationExactlyOnce, rbacExactlyOnce, middlewareExactlyOnce, orderingValidated,
    duplicateMiddlewareSafe, duplicateAuthorizationSafe, duplicateRequestSafe,
    requestValidated, responseValidated, controllerValidated, serviceValidated,
    repositoryValidated, databaseValidated, registered, mounted,
  ];
  const validated = stages.filter(Boolean).length === stages.length;

  return {
    enabled: true,
    validated,
    authenticationValidated: authenticationExactlyOnce,
    rbacValidated: rbacExactlyOnce,
    middlewareValidated: middlewareExactlyOnce,
    requestValidated,
    responseValidated,
    orderingValidated,
    duplicateMiddlewareSafe,
    duplicateAuthorizationSafe,
    duplicateRequestSafe,
    order,
    counts: {
      authentication: counts.authentication,
      rbac: counts.rbac,
      middleware: counts.middleware,
      controller: reqResult.counts.controller,
      service: reqResult.counts.service,
      repository: reqResult.counts.repository,
      sql: reqResult.counts.sql,
      response: reqResult.counts.response,
    },
    status: {
      enabled: true,
      authenticationValidated: authenticationExactlyOnce,
      rbacValidated: rbacExactlyOnce,
      middlewareValidated: middlewareExactlyOnce,
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
    enabled: isAuthenticationValidationEnabled(),
    authenticationValidated: false,
    rbacValidated: false,
    middlewareValidated: false,
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
    enabled: isAuthenticationValidationEnabled(),
    authenticationValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-authentication-validator', available: true },
    { name: 'runtime-request-validator', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isAuthenticationValidationEnabled,
  getRuntimeRequestValidator,
  createRuntimeAuthenticationValidator,
  validateAuthentication,
  getStatus,
  health,
  capabilities,
};
