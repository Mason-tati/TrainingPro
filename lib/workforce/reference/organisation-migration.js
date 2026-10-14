// EWP-01b — Enterprise Workforce Platform — Reference & Organisation — Migration.
//
// Defines the eight organisation-hierarchy reference tables using ONLY the EWP-01a migration-factory
// (no bespoke migration logic). Every table inherits the standard lifecycle block and the optional RLS/
// multi-tenancy scope block from the factory, plus the shared organisation columns (uuid, code, name,
// description, displayOrder, parentId). The eight tables form the strict typed chain
// Company → BusinessUnit → Region → Country → Site → Division → Department → CostCentre; each level's
// parentId references the integer id of the immediately-higher level. Idempotent, never applied to
// production by this module, deterministic, never-throw. UNWIRED.
'use strict';

const { defineTable } = require('../migration-factory');

// The ordered level chain. `parent` is the level name of the immediate parent (null for the root).
const LEVELS = [
  { level: 'COMPANY', table: 'tblCompany', parent: null },
  { level: 'BUSINESS_UNIT', table: 'tblBusinessUnit', parent: 'COMPANY' },
  { level: 'REGION', table: 'tblRegion', parent: 'BUSINESS_UNIT' },
  { level: 'COUNTRY', table: 'tblCountry', parent: 'REGION' },
  { level: 'SITE', table: 'tblSite', parent: 'COUNTRY' },
  { level: 'DIVISION', table: 'tblDivision', parent: 'SITE' },
  { level: 'DEPARTMENT', table: 'tblDepartment', parent: 'DIVISION' },
  { level: 'COST_CENTRE', table: 'tblCostCentre', parent: 'DEPARTMENT' },
];

// The shared organisation columns (identical for every level). The factory adds id + scope + lifecycle.
function organisationColumns() {
  return [
    { name: 'uuid', type: 'TEXT' },
    { name: 'code', type: 'TEXT', notNull: true },
    { name: 'name', type: 'TEXT', notNull: true },
    { name: 'description', type: 'TEXT' },
    { name: 'displayOrder', type: 'INTEGER' },
    { name: 'parentId', type: 'INTEGER' },
  ];
}

// One factory-built migration per level, keyed by level name (built once at module load).
const MIGRATIONS = new Map(
  LEVELS.map((L) => [L.level, defineTable({ table: L.table, columns: organisationColumns(), includeScope: true })]),
);

function getLevels() {
  return LEVELS.map((L) => Object.assign({}, L));
}
function getMigration(level) {
  return MIGRATIONS.get(level) || null;
}

// Migrate all eight tables (parents first). Never-throw; aggregates the per-table factory results.
async function migrate(db) {
  const tables = [];
  for (const L of LEVELS) {
    const r = await MIGRATIONS.get(L.level).migrate(db);
    tables.push({ level: L.level, table: L.table, migrated: r.migrated, error: r.error });
  }
  return { migrated: tables.every((t) => t.migrated), tables };
}

// Verify all eight tables exist.
async function verify(db) {
  const tables = [];
  for (const L of LEVELS) {
    const r = await MIGRATIONS.get(L.level).verify(db);
    tables.push({ level: L.level, table: L.table, exists: r.exists, columns: r.columns });
  }
  return { verified: tables.every((t) => t.exists), tables };
}

// Roll all eight tables back (children first).
async function rollback(db) {
  const tables = [];
  for (let i = LEVELS.length - 1; i >= 0; i -= 1) {
    const L = LEVELS[i];
    const r = await MIGRATIONS.get(L.level).rollback(db);
    tables.push({ level: L.level, table: L.table, rolledBack: r.rolledBack, error: r.error });
  }
  return { rolledBack: tables.every((t) => t.rolledBack), tables };
}

module.exports = {
  LEVELS: getLevels(),
  getLevels,
  getMigration,
  organisationColumns,
  migrate,
  verify,
  rollback,
};
