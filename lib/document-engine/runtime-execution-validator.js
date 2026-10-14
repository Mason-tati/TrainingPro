// WP-25 · Phase 1 — Enterprise Document Engine Runtime Execution Validator.
//
// The first phase of the Live Runtime Validation Program. It validates the COMPLETE runtime
// execution chain the WP-24 mount exposes — Express -> Mount -> Controller -> Service -> Repository
// -> Database — while preserving the feature-flag safety model. When DOCUMENT_ENGINE_ENABLED is
// unset/false (the default), validateRuntimeExecution() is a strict no-op: it resolves nothing,
// executes NO controller/service/repository method, runs NO SQL, and changes NO runtime behaviour.
//
// It reaches the reused controller/service/repository ONLY through server-mount-integration's mount
// plan (its sole non-flag import), so it never re-composes or duplicates the engine. When enabled it
// exercises the chain exactly once against an INSTRUMENTED, in-memory connection (never the
// production database): one guarded mount (idempotent — no duplicate registration), one controller
// invocation, one service invocation, one repository invocation, and exactly one SQL statement.
//
// Its only imports are ./runtime-feature-flag and ./server-mount-integration. It creates no Express,
// no HTTP server, no real database connection; it reads NO environment itself (only the runtime
// feature flag reads the environment). Deterministic, copy-on-read (fresh objects every call),
// stateless (no globals/singleton/cache/module state), and NEVER throws — a failed validation
// degrades to an explicit negative result rather than crashing. UNWIRED — nothing in production
// imports it; the engine stays invisible by default.
'use strict';

const runtimeFeatureFlag = require('./runtime-feature-flag');
const serverMountIntegration = require('./server-mount-integration');

const MOUNT_PATH = '/api/document-engine';
// Fixed sentinel id used only against the instrumented connection — never touches production data.
const VALIDATION_DOCUMENT_ID = 1;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Enabled iff the runtime feature flag is enabled — OFF by default.
function isRuntimeValidationEnabled() {
  return runtimeFeatureFlag.isEnabled();
}

// The reused WP-24 server mount (the validator's single execution entry point).
function getServerMount() {
  return serverMountIntegration;
}

// A deterministic, in-memory connection used ONLY for validation. It performs NO real I/O and
// returns a canned deterministic row so the reused repository layer can be exercised without the
// production database. The validated read path uses `get`; run/get/all share one implementation,
// which satisfies the injected-connection contract the repositories check.
function createInstrumentedConnection() {
  function statement(sql, params, callback) {
    return callback(null, { DocumentID: VALIDATION_DOCUMENT_ID, IsDeleted: 0 });
  }
  return { run: statement, get: statement, all: statement };
}

// Wrap a connection so every executed statement is counted uniformly (internal or injected), then
// delegated unchanged. One wrapper factory covers run/get/all — no per-primitive branching.
function countingConnection(connection, counter) {
  function wrap(primitive) {
    return function counted(sql, params, callback) {
      counter.sql += 1;
      return primitive.call(connection, sql, params, callback);
    };
  }
  return { run: wrap(connection.run), get: wrap(connection.get), all: wrap(connection.all) };
}

// The inert result returned when validation is disabled — nothing was resolved or executed.
function disabledResult() {
  return {
    enabled: false,
    executed: false,
    express: false,
    mount: false,
    controller: false,
    service: false,
    repository: false,
    database: false,
    duplicateRegistrationSafe: false,
    counts: { controller: 0, service: 0, repository: 0, sql: 0 },
    status: getStatus(),
  };
}

// The negative result returned when an enabled validation cannot complete (never throws).
function failedResult(sqlCount) {
  return {
    enabled: true,
    executed: false,
    express: false,
    mount: false,
    controller: false,
    service: false,
    repository: false,
    database: false,
    duplicateRegistrationSafe: false,
    counts: { controller: 0, service: 0, repository: 0, sql: sqlCount },
    status: {
      enabled: true,
      runtimeValidated: false,
      mountValidated: false,
      controllerValidated: false,
      serviceValidated: false,
      repositoryValidated: false,
      databaseValidated: false,
      registered: false,
      mounted: false,
      production: false,
      mode: 'FOUNDATION',
    },
  };
}

// Prepare the runtime execution validator descriptor only (no execution).
function createRuntimeExecutionValidator() {
  return {
    enabled: isRuntimeValidationEnabled(),
    serverMount: getServerMount(),
    status: getStatus(),
  };
}

// Validate the complete runtime execution chain. Disabled: strict no-op. Enabled: exercise the
// reused Express mount + controller + service + repository + database exactly once against a counted
// connection and report per-stage results. `options.db` (optional) injects a connection for testing.
async function validateRuntimeExecution(options) {
  if (!isRuntimeValidationEnabled()) {
    return disabledResult();
  }
  const opts = isPlainObject(options) ? options : {};
  const counter = { sql: 0 };
  try {
    const baseConnection = 'db' in opts ? opts.db : createInstrumentedConnection();
    const db = countingConnection(baseConnection, counter);
    const serverMount = getServerMount();

    // ---- Express + Mount stage: single guarded registration, idempotent (no duplicate) ----
    const uses = [];
    const app = { use(...args) { uses.push(args); return this; } };
    const first = serverMount.mount(app);
    const second = serverMount.mount(app); // second call must NOT register again
    const expressValidated = first.mounted === true;
    const mountCountValidated = uses.length === 1;
    const mountPathValidated = uses[0][0] === MOUNT_PATH;
    const mountStage = [mountCountValidated, mountPathValidated].filter(Boolean).length === 2;
    const duplicateRegistrationSafe = second.alreadyMounted === true;

    // ---- reused composition resolved via the mount plan (Controller + Service + Repository) ----
    const plan = serverMount.getMountPlan({ db });
    const controller = plan.mountPlan.controller;
    const service = plan.mountPlan.services.documentService;
    const repository = service.repository;

    // Controller stage — invoke the shared controller exactly once (never mutated).
    let controllerCount = 0;
    controller.health();
    controllerCount += 1;
    const controllerValidated = controllerCount === 1;

    // Service + Repository stage — count invocations on the FRESH (per-call, discarded) instances.
    // These instances are created by this call and thrown away; no shared/module state is mutated.
    let serviceCount = 0;
    let repositoryCount = 0;
    const realGetById = repository.getById.bind(repository);
    repository.getById = function countedGetById(id) { repositoryCount += 1; return realGetById(id); };
    const realGetDocument = service.getDocument.bind(service);
    service.getDocument = function countedGetDocument(id) { serviceCount += 1; return realGetDocument(id); };

    // Composition/registration must not have executed any SQL before the chain is driven.
    const sqlBeforeDrive = counter.sql;

    // Drive the real service -> repository -> database sub-chain exactly once.
    const row = await service.getDocument(VALIDATION_DOCUMENT_ID);

    const noSqlDuringRegistration = sqlBeforeDrive === 0;
    const rowValidated = row !== undefined;
    const serviceValidated = serviceCount === 1;
    const repositoryValidated = repositoryCount === 1;
    const databaseValidated = counter.sql === 1;

    const stages = [
      expressValidated, mountStage, duplicateRegistrationSafe, noSqlDuringRegistration,
      controllerValidated, serviceValidated, repositoryValidated, databaseValidated, rowValidated,
    ];
    const executed = stages.filter(Boolean).length === stages.length;

    return {
      enabled: true,
      executed,
      express: expressValidated,
      mount: mountStage,
      controller: controllerValidated,
      service: serviceValidated,
      repository: repositoryValidated,
      database: databaseValidated,
      duplicateRegistrationSafe,
      counts: { controller: controllerCount, service: serviceCount, repository: repositoryCount, sql: counter.sql },
      status: {
        enabled: true,
        runtimeValidated: executed,
        mountValidated: mountStage,
        controllerValidated,
        serviceValidated,
        repositoryValidated,
        databaseValidated,
        registered: mountCountValidated,
        mounted: mountCountValidated,
        production: false,
        mode: 'FOUNDATION',
      },
    };
  } catch (e) {
    return failedResult(counter.sql);
  }
}

// A fresh deterministic status object every call (pre-run: nothing validated by merely reading it).
function getStatus() {
  return {
    enabled: isRuntimeValidationEnabled(),
    runtimeValidated: false,
    mountValidated: false,
    controllerValidated: false,
    serviceValidated: false,
    repositoryValidated: false,
    databaseValidated: false,
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
    enabled: isRuntimeValidationEnabled(),
    runtimeValidationAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'runtime-execution-validator', available: true },
    { name: 'server-mount-integration', available: true },
    { name: 'runtime-feature-flag', available: true },
    { name: 'production-safe', available: true },
  ];
}

module.exports = {
  isRuntimeValidationEnabled,
  getServerMount,
  createRuntimeExecutionValidator,
  validateRuntimeExecution,
  getStatus,
  health,
  capabilities,
};
