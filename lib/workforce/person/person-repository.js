// EWP-01c — Enterprise Workforce Platform — Person & Identity — Repository.
//
// Thin configuration over the EWP-01a generic-lifecycle-repository (no persistence logic re-implemented).
// Declares the Person allow-lists: uuid and personNumber are the immutable identity keys (insertable,
// never updatable); the identity/lookup columns are filterable so the service can resolve by uuid /
// personNumber / email / passport / nationalId / document number and search by name. The RLS scope
// columns are wired for future multi-tenancy. UNWIRED.
'use strict';

const { createRepository } = require('../generic-lifecycle-repository');
const { TABLE } = require('./person-migration');

const CONTENT = [
  'title', 'firstName', 'middleName', 'lastName', 'preferredName', 'gender', 'dateOfBirth', 'nationality',
  'primaryLanguage', 'secondaryLanguage', 'email', 'mobile', 'alternatePhone', 'emergencyContactName',
  'emergencyContactPhone', 'emergencyContactRelationship', 'identityDocumentType', 'identityDocumentNumber',
  'passportNumber', 'passportExpiry', 'nationalId', 'photoUrl', 'signatureUrl',
];
// uuid + personNumber are immutable identity keys → insertable but not updatable.
const INSERTABLE = ['uuid', 'personNumber'].concat(CONTENT, ['active', 'archived', 'deleted', 'metadataJson']);
const UPDATABLE = CONTENT.concat(['active', 'archived', 'deleted', 'metadataJson']);
const FILTERABLE = [
  'uuid', 'personNumber', 'email', 'mobile', 'passportNumber', 'nationalId', 'identityDocumentNumber',
  'firstName', 'lastName', 'gender', 'nationality', 'dateOfBirth', 'primaryLanguage',
];
const SCOPE_COLUMNS = ['tenantId', 'companyId', 'siteId'];

function personRepositoryConfig(auditHook) {
  return {
    table: TABLE,
    insertable: INSERTABLE.slice(),
    updatable: UPDATABLE.slice(),
    filterable: FILTERABLE.slice(),
    scopeColumns: SCOPE_COLUMNS.slice(),
    auditHook,
  };
}

function createPersonRepository(db, options) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  return createRepository(db, personRepositoryConfig(opts.auditHook));
}

module.exports = {
  INSERTABLE: INSERTABLE.slice(),
  UPDATABLE: UPDATABLE.slice(),
  FILTERABLE: FILTERABLE.slice(),
  SCOPE_COLUMNS: SCOPE_COLUMNS.slice(),
  personRepositoryConfig,
  createPersonRepository,
};
