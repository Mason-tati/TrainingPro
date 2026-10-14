// EWP-01a — Workforce Foundation Framework — migration-factory tests.
// The factory builds table migrations with the standard lifecycle/scope blocks. It creates NO business
// table; tests define an ephemeral throwaway table in an in-memory DB only.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const MF = require(path.join(__dirname, '..', 'lib', 'workforce', 'migration-factory.js'));

const errDb = {
  run: (s, p, cb) => cb(new Error('boom')),
  get: (s, p, cb) => cb(new Error('boom')),
  all: (s, p, cb) => cb(new Error('boom')),
};
const nullDb = {
  run: (s, p, cb) => cb.call({ lastID: 1, changes: 1 }, null),
  get: (s, p, cb) => cb(null, undefined),
  all: (s, p, cb) => cb(null, undefined),
};
const spec = () => ({ table: 'tblWorkforceFactoryTest', columns: [{ name: 'label', type: 'TEXT', notNull: true }, { name: 'qty', type: 'INTEGER', default: '0' }, { name: 'note' }] });

test('EWP-MF-1. defineTable rejects missing / empty / non-object spec', () => {
  assert.throws(() => MF.defineTable(null), /non-empty table name/);
  assert.throws(() => MF.defineTable({}), /non-empty table name/);
  assert.throws(() => MF.defineTable({ table: '  ' }), /non-empty table name/);
});

test('EWP-MF-2. getColumns / getCreateTableSql include id + user + lifecycle; note defaults to TEXT', () => {
  const m = MF.defineTable(spec());
  assert.equal(m.getTableName(), 'tblWorkforceFactoryTest');
  assert.deepEqual(m.getColumns(), ['id', 'label', 'qty', 'note', 'active', 'archived', 'deleted', 'metadataJson', 'createdAt', 'updatedAt']);
  const sql = m.getCreateTableSql();
  assert.match(sql, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(sql, /label TEXT NOT NULL/);
  assert.match(sql, /qty INTEGER DEFAULT 0/);
  assert.match(sql, /note TEXT/);
  assert.match(sql, /active INTEGER NOT NULL DEFAULT 1/);
});

test('EWP-MF-3. migrate creates the table; verify reports it exists with all columns; rollback drops it', async () => {
  const db = new sqlite3.Database(':memory:');
  const m = MF.defineTable(spec());
  assert.deepEqual(await m.migrate(db), { migrated: true, table: 'tblWorkforceFactoryTest' });
  const v = await m.verify(db);
  assert.equal(v.verified, true);
  assert.equal(v.columns.length, 10);
  assert.deepEqual(await m.rollback(db), { rolledBack: true, table: 'tblWorkforceFactoryTest' });
  assert.equal((await m.verify(db)).exists, false);
  db.close();
});

test('EWP-MF-4. includeLifecycle:false omits the lifecycle block', () => {
  const m = MF.defineTable({ table: 'tblWorkforceNoLifecycle', columns: [{ name: 'label', type: 'TEXT' }], includeLifecycle: false });
  assert.deepEqual(m.getColumns(), ['id', 'label']);
});

test('EWP-MF-5. includeScope:true adds the RLS scope block', () => {
  const m = MF.defineTable({ table: 'tblWorkforceScoped', columns: [{ name: 'label', type: 'TEXT' }], includeScope: true });
  const cols = m.getColumns();
  assert.ok(cols.includes('tenantId') && cols.includes('companyId') && cols.includes('siteId'));
});

test('EWP-MF-6. a user-supplied primary key suppresses the auto id column', async () => {
  const db = new sqlite3.Database(':memory:');
  const m = MF.defineTable({ table: 'tblWorkforcePk', columns: [{ name: 'code', type: 'INTEGER', primaryKey: true }, { name: 'label', type: 'TEXT' }] });
  assert.equal(m.getColumns()[0], 'code');
  assert.ok(!m.getColumns().includes('id'));
  assert.equal((await m.migrate(db)).migrated, true);
  db.close();
});

test('EWP-MF-7. migrate / verify / rollback surface DB errors without throwing', async () => {
  const m = MF.defineTable(spec());
  assert.equal((await m.migrate(errDb)).migrated, false);
  const v = await m.verify(errDb);
  assert.equal(v.verified, false);
  assert.deepEqual(v.columns, []);
  assert.equal((await m.rollback(errDb)).rolledBack, false);
});

test('EWP-MF-8. verify with a null-returning connection (row-null / rows-empty, ok path)', async () => {
  const m = MF.defineTable(spec());
  const v = await m.verify(nullDb);
  assert.equal(v.exists, false);
  assert.deepEqual(v.columns, []);
  assert.equal((await m.migrate(nullDb)).migrated, true);
});

test('EWP-MF-8b. a spec with no columns array yields id + lifecycle only', () => {
  const m = MF.defineTable({ table: 'tblWorkforceNoCols' });
  assert.deepEqual(m.getColumns(), ['id', 'active', 'archived', 'deleted', 'metadataJson', 'createdAt', 'updatedAt']);
});

test('EWP-MF-9. exported LIFECYCLE_COLUMNS / SCOPE_COLUMNS are defensive copies', () => {
  MF.LIFECYCLE_COLUMNS.push({ name: 'HACK' });
  MF.SCOPE_COLUMNS.push({ name: 'HACK' });
  const m = MF.defineTable({ table: 'tblWorkforceCopyCheck', columns: [], includeScope: true });
  assert.ok(!m.getColumns().includes('HACK'), 'internal blocks not mutated');
});
