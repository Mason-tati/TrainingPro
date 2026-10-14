// WP-21 · Phase 1 — Enterprise Document Engine Persistence Composition Root.
//
// The first REAL integration layer: it connects the already-built WP-18 repository/service layer
// to the EXISTING TrainingPro database connection (database/db.js). It does NOT mount routes, does
// NOT modify server.js, does NOT enable the engine, and does NOT change runtime behaviour. The
// engine remains disabled behind the OFF feature flag (./runtime-feature-flag).
//
// It obtains the SHARED database handle via database/db.js's getDb() (never opens SQLite, never
// imports sqlite3, never creates a new connection, never runs migrations, never writes). It only
// constructs the repository/service object graph via dependency injection. Every public function
// is deterministic, copy-on-read (fresh objects every call), stateless (no module state, no
// singleton, no cache), and NEVER throws — if a repository or service cannot be constructed (e.g.
// the DB is not yet initialised), it degrades to a safe `null` in the returned graph rather than
// crashing. UNWIRED — nothing in production imports this module.
'use strict';

const featureFlag = require('./runtime-feature-flag');
const dbModule = require('../../database/db');

const DocumentRepository = require('./repositories/document-repository');
const VersionRepository = require('./repositories/version-repository');
const MetadataRepository = require('./repositories/metadata-repository');
const RelationshipRepository = require('./repositories/relationship-repository');
const ApprovalRepository = require('./repositories/approval-repository');
const DistributionRepository = require('./repositories/distribution-repository');
const AccessRepository = require('./repositories/access-repository');
const NotificationRepository = require('./repositories/notification-repository');
const ValidationRepository = require('./repositories/validation-repository');
const ComplianceRepository = require('./repositories/compliance-repository');
const SearchRepository = require('./repositories/search-repository');

const DocumentService = require('./services/document-service');
const VersionService = require('./services/version-service');
const MetadataService = require('./services/metadata-service');
const RelationshipService = require('./services/relationship-service');
const ApprovalService = require('./services/approval-service');
const DistributionService = require('./services/distribution-service');
const AccessService = require('./services/access-service');
const NotificationService = require('./services/notification-service');
const ValidationService = require('./services/validation-service');
const ComplianceService = require('./services/compliance-service');
const SearchService = require('./services/search-service');

// ---- internal helpers (never throw) ----

// Construct `new Ctor(arg)`; return the instance, or null if construction throws (e.g. the
// injected dependency is missing/invalid). No side effects beyond object construction.
function safeConstruct(Ctor, arg) {
  try {
    return new Ctor(arg);
  } catch (e) {
    return null;
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---- public API ----

// Enabled iff the (permanently OFF) feature flag says so — currently false.
function isWiringEnabled() {
  return featureFlag.isEnabled();
}

// Return the SHARED database connection from the existing database/db.js API. Uses getDb() only;
// never opens SQLite, never creates a new connection. Returns null if the DB is not yet
// initialised (getDb throws in that state) — never throws.
function getDatabaseConnection() {
  try {
    return dbModule.getDb();
  } catch (e) {
    return null;
  }
}

// Fresh repository instances every call. `db` is optional; when omitted the shared connection is
// used. Each repository degrades to null if it cannot be constructed against the given connection.
function createRepositories(db) {
  const connection = db === undefined ? getDatabaseConnection() : db;
  return {
    documentRepository: safeConstruct(DocumentRepository, connection),
    versionRepository: safeConstruct(VersionRepository, connection),
    metadataRepository: safeConstruct(MetadataRepository, connection),
    relationshipRepository: safeConstruct(RelationshipRepository, connection),
    approvalRepository: safeConstruct(ApprovalRepository, connection),
    distributionRepository: safeConstruct(DistributionRepository, connection),
    accessRepository: safeConstruct(AccessRepository, connection),
    notificationRepository: safeConstruct(NotificationRepository, connection),
    validationRepository: safeConstruct(ValidationRepository, connection),
    complianceRepository: safeConstruct(ComplianceRepository, connection),
    searchRepository: safeConstruct(SearchRepository, connection),
  };
}

// Fresh service instances every call. `repositories` is optional; when omitted a fresh repository
// set is created. Each service degrades to null if its repository dependency is missing/invalid.
function createServices(repositories) {
  const repos = repositories === undefined ? createRepositories() : repositories;
  const src = isPlainObject(repos) ? repos : {};
  return {
    documentService: safeConstruct(DocumentService, src.documentRepository),
    versionService: safeConstruct(VersionService, src.versionRepository),
    metadataService: safeConstruct(MetadataService, src.metadataRepository),
    relationshipService: safeConstruct(RelationshipService, src.relationshipRepository),
    approvalService: safeConstruct(ApprovalService, src.approvalRepository),
    distributionService: safeConstruct(DistributionService, src.distributionRepository),
    accessService: safeConstruct(AccessService, src.accessRepository),
    notificationService: safeConstruct(NotificationService, src.notificationRepository),
    validationService: safeConstruct(ValidationService, src.validationRepository),
    complianceService: safeConstruct(ComplianceService, src.complianceRepository),
    searchService: safeConstruct(SearchService, src.searchRepository),
  };
}

// Prepare the object graph ONLY. Never registers routes, never touches server.js, never performs
// CRUD, never writes to the database. `options.db` (optional) injects a connection for testing.
function createComposition(options) {
  const opts = isPlainObject(options) ? options : {};
  const connection = 'db' in opts ? opts.db : getDatabaseConnection();
  const repositories = createRepositories(connection);
  const services = createServices(repositories);
  return {
    enabled: isWiringEnabled(),
    db: connection,
    repositories,
    services,
    status: { wired: false, production: false, mode: 'FOUNDATION' },
  };
}

// A fresh deterministic health descriptor every call. "available" means the layer's modules are
// present and constructable, not that a live connection exists; `enabled` reflects the (OFF) flag.
function health() {
  return {
    ready: true,
    enabled: isWiringEnabled(),
    databaseAvailable: true,
    repositoriesAvailable: true,
    servicesAvailable: true,
  };
}

// A fresh deterministic capability list every call.
function capabilities() {
  return [
    { name: 'database-connection', available: true },
    { name: 'repositories', available: true },
    { name: 'services', available: true },
    { name: 'feature-flag-disabled', available: true },
  ];
}

// A fresh deterministic status object every call.
function getStatus() {
  return {
    enabled: isWiringEnabled(),
    wired: false,
    production: false,
    mode: 'FOUNDATION',
  };
}

module.exports = {
  isWiringEnabled,
  getDatabaseConnection,
  createRepositories,
  createServices,
  createComposition,
  health,
  capabilities,
  getStatus,
};
