// EWP-01c — Enterprise Workforce Platform — Person & Identity — Migration.
//
// Defines the single Person master table (tblPerson) using ONLY the EWP-01a migration-factory. The table
// inherits the standard lifecycle block and the optional RLS/multi-tenancy scope block from the factory,
// plus the person identity columns. tblPerson is the single source of truth for every human recorded in
// the platform — personal information lives here and is referenced (never duplicated) by future modules.
// firstName and lastName are NOT NULL (a person must have a name); everything else is nullable and
// validated by the service. Idempotent, never applied to production, deterministic, never-throw. UNWIRED.
'use strict';

const { defineTable } = require('../migration-factory');

const TABLE = 'tblPerson';

// The 25 identity columns (the factory adds id, the scope block, and the lifecycle block incl. metadataJson).
function personColumns() {
  return [
    { name: 'uuid', type: 'TEXT' },
    { name: 'personNumber', type: 'TEXT' },
    { name: 'title', type: 'TEXT' },
    { name: 'firstName', type: 'TEXT', notNull: true },
    { name: 'middleName', type: 'TEXT' },
    { name: 'lastName', type: 'TEXT', notNull: true },
    { name: 'preferredName', type: 'TEXT' },
    { name: 'gender', type: 'TEXT' },
    { name: 'dateOfBirth', type: 'TEXT' },
    { name: 'nationality', type: 'TEXT' },
    { name: 'primaryLanguage', type: 'TEXT' },
    { name: 'secondaryLanguage', type: 'TEXT' },
    { name: 'email', type: 'TEXT' },
    { name: 'mobile', type: 'TEXT' },
    { name: 'alternatePhone', type: 'TEXT' },
    { name: 'emergencyContactName', type: 'TEXT' },
    { name: 'emergencyContactPhone', type: 'TEXT' },
    { name: 'emergencyContactRelationship', type: 'TEXT' },
    { name: 'identityDocumentType', type: 'TEXT' },
    { name: 'identityDocumentNumber', type: 'TEXT' },
    { name: 'passportNumber', type: 'TEXT' },
    { name: 'passportExpiry', type: 'TEXT' },
    { name: 'nationalId', type: 'TEXT' },
    { name: 'photoUrl', type: 'TEXT' },
    { name: 'signatureUrl', type: 'TEXT' },
  ];
}

const migration = defineTable({ table: TABLE, columns: personColumns(), includeScope: true });

module.exports = {
  TABLE,
  personColumns,
  getTableName: migration.getTableName,
  getColumns: migration.getColumns,
  getCreateTableSql: migration.getCreateTableSql,
  migrate: migration.migrate,
  verify: migration.verify,
  rollback: migration.rollback,
};
