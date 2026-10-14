// EWP-01b — Enterprise Workforce Platform — Reference & Organisation — Repository.
//
// Thin configuration over the EWP-01a generic-lifecycle-repository (no persistence logic re-implemented):
// one generic repository per organisation level, assembled into a single EWP-01a repository-registry
// keyed by level name. The registry is the composition seam the organisation service reads. Allow-listed
// columns are declared here; uuid is immutable (insertable, not updatable); the RLS scope columns are
// wired for future multi-tenancy. UNWIRED.
'use strict';

const { createRepository } = require('../generic-lifecycle-repository');
const { createRegistry } = require('../repository-registry');
const { LEVELS } = require('./organisation-migration');

const INSERTABLE = ['uuid', 'code', 'name', 'description', 'displayOrder', 'parentId', 'active', 'archived', 'deleted', 'metadataJson'];
// uuid is the immutable public identifier and is never updated.
const UPDATABLE = ['code', 'name', 'description', 'displayOrder', 'parentId', 'active', 'archived', 'deleted', 'metadataJson'];
const FILTERABLE = ['code', 'name', 'parentId', 'displayOrder'];
const SCOPE_COLUMNS = ['tenantId', 'companyId', 'siteId'];

function levelRepositoryConfig(table, auditHook) {
  return {
    table,
    insertable: INSERTABLE.slice(),
    updatable: UPDATABLE.slice(),
    filterable: FILTERABLE.slice(),
    scopeColumns: SCOPE_COLUMNS.slice(),
    auditHook,
  };
}

// Build one generic repository for a single level's table.
function createLevelRepository(db, table, auditHook) {
  return createRepository(db, levelRepositoryConfig(table, auditHook));
}

// Build all eight level repositories and register them, by level name, in a fresh EWP-01a registry.
function createOrganisationRegistry(db, options) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const registry = createRegistry();
  for (const L of LEVELS) {
    registry.register(L.level, createLevelRepository(db, L.table, opts.auditHook));
  }
  return registry;
}

module.exports = {
  INSERTABLE: INSERTABLE.slice(),
  UPDATABLE: UPDATABLE.slice(),
  FILTERABLE: FILTERABLE.slice(),
  SCOPE_COLUMNS: SCOPE_COLUMNS.slice(),
  levelRepositoryConfig,
  createLevelRepository,
  createOrganisationRegistry,
};
