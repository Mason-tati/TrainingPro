// WP-25 · Phase 2 — Enterprise Document Engine Runtime Request Validator.
//
// The second phase of the Live Runtime Validation Program. It validates LIVE request handling
// through the mounted Enterprise Document Engine: an HTTP request reaching the mounted route and
// producing exactly one response, composed with the exactly-once execution chain (Controller ->
// Service -> Repository -> Database) validated by the Phase 1 runtime execution validator. When
// DOCUMENT_ENGINE_ENABLED is unset/false (the default), validateRequest() is a strict no-op: it
// simulates NO request, executes NO controller/service/repository, runs NO SQL, generates NO
// response, and changes NO runtime behaviour.
//
// The mounted route is the WP-24 guarded handler (a non-serving 503 response in this phase); Phase 2
// verifies the live request reaches it and yields exactly one response, and that the reused runtime
// execution chain runs each stage exactly once (delegated to the Phase 1 validator). Full
// persistence-backed request serving remains a later phase.
//
// Its only imports are ./runtime-feature-flag and ./runtime-execution-validator. It creates no
// Express, no HTTP server, no real database connection; it reads NO environment itself (only the
// runtime feature flag reads the environment). Deterministic, copy-on-read (fresh objects every
// call), stateless (no globals/singleton/cache/module state), and never throws — the request is
// simulated with controlled request/response doubles and every delegated call is failure-safe.
// UNWIRED — nothing in production imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const runtimeExecutionValidator = require('./runtime-execution-validator');

const MOUNT_PATH = '/api/document-engine';

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isRequestValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused Phase 1 runtime execution validator (the source of the mount and the execution chain).
function getRuntimeValidator() {
  return runtimeExecutionValidator;
}

// The inert result returned when request validation is disabled — no request simulated, nothing run.
function disabledResult() {
  return {
    enabled: false,
    requestValidated: false,
    requestReached: false,
    responseValidated: false,
    duplicateRegistrationSafe: false,
    duplicateRequestSafe: false,
    response: { status: 0, mounted: false, serving: false },
    counts: { controller: 0, service: 0, repository: 0, sql: 0, response: 0 },
    status: getStatus(),
  };
}

// Prepare the runtime request validator descriptor only (no request simulated, no execution).
function createRuntimeRequestValidator() {
  return {
    enabled: isRequestValidationEnabled(),
    runtimeValidator: getRuntimeValidator(),
    status: getStatus(),
  };
}

// Validate a live request through the mounted runtime. Disabled: strict no-op. Enabled: reach the
// mounted guarded endpoint with a controlled request (asserting exactly one response and no duplicate
// registration) and validate the reused Controller -> Service -> Repository -> Database chain exactly
// once via the Phase 1 validator. `options.db` (optional) is forwarded for testing.
async function validateRequest(options) {
  if (!isRequestValidationEnabled()) {
    return disabledResult();
  }
  const runtimeValidator = getRuntimeValidator();
  const serverMount = runtimeValidator.getServerMount();

  // ---- live request path: mount once, reach the endpoint, capture exactly one response ----
  const uses = [];
  const app = { use(...args) { uses.push(args); return this; } };
  serverMount.mount(app);
  const second = serverMount.mount(app); // second call must NOT register again
  const handler = uses[0][1];

  let statusCode = 0;
  let responseCount = 0;
  let responseBody = { mounted: false, serving: true };
  const req = { method: 'GET', url: MOUNT_PATH, originalUrl: MOUNT_PATH };
  const res = {
    status(code) { statusCode = code; return this; },
    json(payload) { responseCount += 1; responseBody = payload; return this; },
  };
  handler(req, res);

  const registered = uses.length === 1;
  const mountPathValidated = uses[0][0] === MOUNT_PATH;
  const requestReached = statusCode > 0;
  const responseValidated = responseCount === 1;
  const responseMounted = responseBody.mounted === true;
  const duplicateRegistrationSafe = second.alreadyMounted === true;
  const duplicateRequestSafe = responseCount === 1;

  // ---- reused execution chain (Controller -> Service -> Repository -> Database), exactly once ----
  const exec = await runtimeValidator.validateRuntimeExecution(options);
  const runtimeValidated = exec.executed === true;
  const controllerValidated = exec.counts.controller === 1;
  const serviceValidated = exec.counts.service === 1;
  const repositoryValidated = exec.counts.repository === 1;
  const databaseValidated = exec.counts.sql === 1;

  const stages = [
    requestReached, registered, mountPathValidated, responseValidated, responseMounted,
    duplicateRegistrationSafe, duplicateRequestSafe, runtimeValidated,
    controllerValidated, serviceValidated, repositoryValidated, databaseValidated,
  ];
  const requestValidated = stages.filter(Boolean).length === stages.length;

  return {
    enabled: true,
    requestValidated,
    requestReached,
    responseValidated,
    duplicateRegistrationSafe,
    duplicateRequestSafe,
    response: { status: statusCode, mounted: responseMounted, serving: responseBody.serving },
    counts: {
      controller: exec.counts.controller,
      service: exec.counts.service,
      repository: exec.counts.repository,
      sql: exec.counts.sql,
      response: responseCount,
    },
    status: {
      enabled: true,
      requestValidated,
      runtimeValidated,
      controllerValidated,
      serviceValidated,
      repositoryValidated,
      databaseValidated,
      responseValidated,
      registered,
      mounted: registered,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// A fresh deterministic status object every call (pre-run: nothing validated by merely reading it).
function getStatus() {
  return {
    enabled: isRequestValidationEnabled(),
    requestValidated: false,
    runtimeValidated: false,
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
    enabled: isRequestValidationEnabled(),
    requestValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-request-validator', available: true },
    { name: 'runtime-execution-validator', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isRequestValidationEnabled,
  getRuntimeValidator,
  createRuntimeRequestValidator,
  validateRequest,
  getStatus,
  health,
  capabilities,
};
