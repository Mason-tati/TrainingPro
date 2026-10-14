// EWP-01c — Person & Identity — repository tests. Thin config over the EWP-01a generic repository.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const PDIR = path.join(__dirname, '..', 'lib', 'workforce', 'person');
const Mig = require(path.join(PDIR, 'person-migration.js'));
const Repo = require(path.join(PDIR, 'person-repository.js'));

async function fresh(options) {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  return { db, repo: Repo.createPersonRepository(db, options) };
}
const mk = (over) => Object.assign({ uuid: 'u1', firstName: 'Jane', lastName: 'Doe' }, over);

test('EWP-PREPO-1. config: uuid + personNumber insertable but not updatable; lookups filterable', () => {
  const cfg = Repo.personRepositoryConfig();
  assert.ok(cfg.insertable.includes('uuid') && cfg.insertable.includes('personNumber'));
  assert.ok(!cfg.updatable.includes('uuid') && !cfg.updatable.includes('personNumber'), 'identity keys immutable');
  for (const f of ['uuid', 'personNumber', 'email', 'passportNumber', 'nationalId', 'lastName']) assert.ok(cfg.filterable.includes(f), `filter ${f}`);
  assert.deepEqual(cfg.scopeColumns, ['tenantId', 'companyId', 'siteId']);
});

test('EWP-PREPO-2. create inserts allow-listed columns; NOT NULL name enforced', async () => {
  const { db, repo } = await fresh();
  const p = await repo.create(mk({ email: 'j@x.com', hacker: 'z' }));
  assert.equal(p.firstName, 'Jane');
  assert.equal(p.email, 'j@x.com');
  assert.equal(p.hacker, undefined);
  await assert.rejects(() => repo.create({ uuid: 'x' }), /NOT NULL constraint failed/);
  db.close();
});

test('EWP-PREPO-3. findBy resolves identity columns; excludes soft-deleted', async () => {
  const { db, repo } = await fresh();
  const p = await repo.create(mk({ personNumber: 'P1', email: 'j@x.com', passportNumber: 'PA1', nationalId: 'N1' }));
  assert.equal((await repo.findBy('personNumber', 'P1')).length, 1);
  assert.equal((await repo.findBy('email', 'j@x.com')).length, 1);
  assert.equal((await repo.findBy('passportNumber', 'PA1')).length, 1);
  assert.equal((await repo.findBy('nationalId', 'N1')).length, 1);
  await repo.softDelete(p.id);
  assert.equal((await repo.findBy('email', 'j@x.com')).length, 0);
  db.close();
});

test('EWP-PREPO-4. scope columns persist and are queryable', async () => {
  const { db, repo } = await fresh();
  await repo.create(mk({ companyId: 7, siteId: 3 }));
  assert.equal((await repo.findBy('companyId', 7)).length, 1);
  db.close();
});

test('EWP-PREPO-5. audit hook propagates from the repository options', async () => {
  const events = [];
  const { db, repo } = await fresh({ auditHook: (e) => events.push(e.action) });
  const p = await repo.create(mk({}));
  await repo.archive(p.id);
  assert.deepEqual(events, ['create', 'archive']);
  db.close();
});

test('EWP-PREPO-5b. findAll supports multi-column filtering over the allow-listed columns', async () => {
  const { db, repo } = await fresh();
  await repo.create(mk({ nationality: 'AU', gender: 'FEMALE' }));
  await repo.create(mk({ uuid: 'u2', firstName: 'Bob', lastName: 'Roe', nationality: 'AU', gender: 'MALE' }));
  assert.equal((await repo.findAll({ nationality: 'AU' })).length, 2);
  assert.equal((await repo.findAll({ nationality: 'AU', gender: 'FEMALE' })).length, 1);
  db.close();
});

test('EWP-PREPO-5c. count and exists honour the soft-delete flag', async () => {
  const { db, repo } = await fresh();
  const p = await repo.create(mk({ email: 'a@x.com' }));
  await repo.create(mk({ uuid: 'u2', firstName: 'Bob', lastName: 'Roe' }));
  assert.equal(await repo.count(), 2);
  await repo.softDelete(p.id);
  assert.equal(await repo.count(), 1, 'deleted excluded from count');
  assert.equal(await repo.exists(p.id), true, 'exists ignores deleted');
  db.close();
});

test('EWP-PREPO-5d. update changes content columns and never touches the immutable identity keys', async () => {
  const { db, repo } = await fresh();
  const p = await repo.create(mk({ personNumber: 'P1' }));
  const upd = await repo.update(p.id, { preferredName: 'Janie', personNumber: 'HACK', uuid: 'HACK' });
  assert.equal(upd.preferredName, 'Janie');
  assert.equal(upd.personNumber, 'P1', 'personNumber not in updatable allow-list');
  assert.equal(upd.uuid, 'u1', 'uuid not in updatable allow-list');
  db.close();
});

test('EWP-PREPO-6. exported allow-lists are defensive copies; non-object options tolerated', async () => {
  Repo.FILTERABLE.push('HACK');
  assert.ok(!Repo.personRepositoryConfig().filterable.includes('HACK'));
  const { db, repo } = await fresh('not-object');
  assert.ok(await repo.create(mk({})));
  db.close();
});
