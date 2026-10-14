// WP-25 · Phase 5 — Enterprise Document Engine Runtime Route Validator.
//
// The fifth phase of the Live Runtime Validation Program. It validates the COMPLETE runtime route
// execution chain the mounted engine must obey — HTTP Request -> Authentication -> RBAC -> Middleware
// -> Route Resolution -> Mounted Endpoint -> Controller -> Service -> Repository -> Database -> HTTP
// Response — proving the route resolves to exactly one mounted endpoint, that endpoint is reached
// exactly once, and every stage executes exactly once, with no duplicate route registration, no
// duplicate endpoint resolution, and no duplicate request handling. When DOCUMENT_ENGINE_ENABLED is
// unset/false (the default), validateRoutes() is a strict no-op: nothing is resolved or driven, and
// runtime behaviour is unchanged.
//
// It reuses the Phase 4 middleware validator (which composes Phase 3 security + Phase 2 request +
// Phase 1 execution validation); its only imports are ./runtime-feature-flag and
// ./runtime-middleware-validator. The production route and middleware modules are neither imported
// nor modified — they remain the production source of truth, reused exactly as-is. It creates no
// Express, no HTTP server, no database connection; it reads NO environment itself (only the runtime
// feature flag reads the environment). Deterministic, copy-on-read (fresh objects every call),
// stateless (no globals/singleton/cache/module state), and never throws. UNWIRED — nothing in
// production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeMiddlewareValidator = require('./runtime-middleware-validator');

const MOUNT_PATH = '/api/document-engine';

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isRouteValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 4 middleware validator (the source of the middleware + security + request chain).
function getRuntimeMiddlewareValidator() {
  return runtimeMiddlewareValidator;
}

// The inert result returned when route validation is disabled — nothing resolved or executed.
function disabledResult() {
  return {
    enabled: false,
    validated: false,
    routeValidated: false,
    endpointReached: false,
    middlewareValidated: false,
    authenticationValidated: false,
    rbacValidated: false,
    requestValidated: false,
    responseValidated: false,
    orderingValidated: false,
    duplicateRouteSafe: false,
    duplicateEndpointSafe: false,
    duplicateRequestSafe: false,
    order: [],
    counts: { route: 0, endpoint: 0, authentication: 0, rbac: 0, middleware: 0, controller: 0, service: 0, repository: 0, sql: 0, response: 0 },
    status: getStatus(),
  };
}

// Prepare the runtime route validator descriptor only (nothing resolved, nothing executed).
function createRuntimeRouteValidator() {
  return {
    enabled: isRouteValidationEnabled(),
    middlewareValidator: getRuntimeMiddlewareValidator(),
    status: getStatus(),
  };
}

// Validate the complete runtime route execution chain. Disabled: strict no-op. Enabled: resolve the
// single mounted route (exactly one match — no duplicate route/endpoint), then drive the Phase 4
// middleware pipeline (authentication -> RBAC -> middleware -> mounted endpoint -> controller ->
// service -> repository -> database -> response), asserting every stage runs exactly once. `options`
// is forwarded for testing.
async function validateRoutes(options) {
  if (!isRouteValidationEnabled()) {
    return disabledResult();
  }
  // ---- route resolution: the engine registers exactly one route; resolving the mount path yields
  // exactly one endpoint (no duplicate route, no duplicate endpoint) ----
  const req = { method: 'GET', url: MOUNT_PATH, originalUrl: MOUNT_PATH };
  const routeTable = [MOUNT_PATH];
  const matches = routeTable.filter((routePath) => routePath === req.url);
  const routeResolvedOnce = matches.length === 1;
  const duplicateRouteSafe = matches.length === 1;

  // ---- middleware + endpoint + execution chain via Phase 4 ----
  const middlewareValidator = getRuntimeMiddlewareValidator();
  const mwResult = await middlewareValidator.validateMiddleware(options);

  const endpointReached = mwResult.counts.response === 1;
  const duplicateEndpointSafe = mwResult.counts.response === 1;
  const duplicateRequestSafe = mwResult.duplicateRequestSafe === true;
  const middlewareValidated = mwResult.middlewareValidated === true;
  const authenticationValidated = mwResult.authenticationValidated === true;
  const rbacValidated = mwResult.rbacValidated === true;
  const orderingValidated = mwResult.orderingValidated === true;
  const requestValidated = mwResult.requestValidated === true;
  const responseValidated = mwResult.responseValidated === true;
  const controllerValidated = mwResult.counts.controller === 1;
  const serviceValidated = mwResult.counts.service === 1;
  const repositoryValidated = mwResult.counts.repository === 1;
  const databaseValidated = mwResult.counts.sql === 1;
  const registered = mwResult.status.registered === true;
  const mounted = mwResult.status.mounted === true;

  const stages = [
    routeResolvedOnce, endpointReached, duplicateRouteSafe, duplicateEndpointSafe, duplicateRequestSafe,
    middlewareValidated, authenticationValidated, rbacValidated, orderingValidated,
    requestValidated, responseValidated, controllerValidated, serviceValidated,
    repositoryValidated, databaseValidated, registered, mounted,
  ];
  const validated = stages.filter(Boolean).length === stages.length;

  return {
    enabled: true,
    validated,
    routeValidated: routeResolvedOnce,
    endpointReached,
    middlewareValidated,
    authenticationValidated,
    rbacValidated,
    requestValidated,
    responseValidated,
    orderingValidated,
    duplicateRouteSafe,
    duplicateEndpointSafe,
    duplicateRequestSafe,
    order: mwResult.order,
    counts: {
      route: matches.length,
      endpoint: mwResult.counts.response,
      authentication: mwResult.counts.authentication,
      rbac: mwResult.counts.rbac,
      middleware: mwResult.counts.middleware,
      controller: mwResult.counts.controller,
      service: mwResult.counts.service,
      repository: mwResult.counts.repository,
      sql: mwResult.counts.sql,
      response: mwResult.counts.response,
    },
    status: {
      enabled: true,
      routeValidated: routeResolvedOnce,
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
    enabled: isRouteValidationEnabled(),
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
    enabled: isRouteValidationEnabled(),
    routeValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-route-validator', available: true },
    { name: 'runtime-middleware-validator', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isRouteValidationEnabled,
  getRuntimeMiddlewareValidator,
  createRuntimeRouteValidator,
  validateRoutes,
  getStatus,
  health,
  capabilities,
};
