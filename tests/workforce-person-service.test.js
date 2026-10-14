// EWP-01c — Person & Identity — service tests. CRUD delegated to the generic service (with identity
// validators) + lookups, search, duplicate detection, and a pure age calculation. Deterministic uuid +
// referenceDate injected; optional EWP-01b org registry validates scope.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const PDIR = path.join(__dirname, '..', 'lib', 'workforce', 'person');
const Mig = require(path.join(PDIR, 'person-migration.js'));
const { createPersonRepository } = require(path.join(PDIR, 'person-repository.js'));
const { PersonService, createPersonService, calculateAge, GENDERS, ID_TYPES } = require(path.join(PDIR, 'person-service.js'));
const OrgMig = require(path.join(__dirname, '..', 'lib', 'workforce', 'reference', 'organisation-migration.js'));
const { createOrganisationRegistry } = require(path.join(__dirname, '..', 'lib', 'workforce', 'reference', 'organisation-repository.js'));
const { createOrganisationService } = require(path.join(__dirname, '..', 'lib', 'workforce', 'reference', 'organisation-service.js'));

async function setup(withOrg) {
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  let n = 0;
  const opts = { uuid: () => `u-${(n += 1)}`, referenceDate: '2026-07-09' };
  let orgIds = {};
  if (withOrg) {
    await OrgMig.migrate(db);
    let o = 0;
    const orgReg = createOrganisationRegistry(db);
    const orgSvc = createOrganisationService(orgReg, { uuid: () => `o-${(o += 1)}` });
    const co = (await orgSvc.createNode('COMPANY', { code: 'C1', name: 'Co' })).node;
    const bu = (await orgSvc.createNode('BUSINESS_UNIT', { code: 'BU1', name: 'BU', parentId: co.id })).node;
    const rg = (await orgSvc.createNode('REGION', { code: 'R1', name: 'Rg', parentId: bu.id })).node;
    const cy = (await orgSvc.createNode('COUNTRY', { code: 'CY1', name: 'Cy', parentId: rg.id })).node;
    const st = (await orgSvc.createNode('SITE', { code: 'S1', name: 'Site', parentId: cy.id })).node;
    opts.organisationRegistry = orgReg;
    orgIds = { companyId: co.id, siteId: st.id };
  }
  return { db, orgIds, service: createPersonService(createPersonRepository(db), opts) };
}
const P = (over) => Object.assign({ firstName: 'Jane', lastName: 'Doe' }, over);

test('EWP-PSVC-1. constructor requires a repository; defaults referenceDate + uuid when not injected', async () => {
  assert.throws(() => new PersonService(null), /person repository/);
  assert.throws(() => new PersonService({}), /person repository/);
  const db = new sqlite3.Database(':memory:');
  await Mig.migrate(db);
  const svc = createPersonService(createPersonRepository(db)); // no uuid / referenceDate injected
  const c = await svc.create(P({}));
  assert.match(c.person.uuid, /^[0-9a-f-]{36}$/);
  assert.match(svc.referenceDate, /^\d{4}-\d{2}-\d{2}$/, 'default referenceDate is today');
  db.close();
});

test('EWP-PSVC-2. create: success with server uuid; requires firstName and lastName; non-object input', async () => {
  const ctx = await setup();
  const c = await ctx.service.create(P({ personNumber: 'P001', email: 'j@x.com' }));
  assert.equal(c.ok, true);
  assert.equal(c.person.uuid, 'u-1');
  assert.equal(c.person.personNumber, 'P001');
  assert.equal((await ctx.service.create({ lastName: 'Doe' })).error, 'firstName is required');
  assert.equal((await ctx.service.create({ firstName: 'Jane' })).error, 'lastName is required');
  assert.equal((await ctx.service.create('nope')).error, 'firstName is required');
  ctx.db.close();
});

test('EWP-PSVC-3. create: format validation (gender / email / dateOfBirth / passportExpiry / idType)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.create(P({ gender: 'X' }))).error, 'invalid gender');
  assert.equal((await ctx.service.create(P({ email: 'not-an-email' }))).error, 'invalid email');
  assert.equal((await ctx.service.create(P({ dateOfBirth: '15/05/1990' }))).error, 'invalid dateOfBirth');
  assert.equal((await ctx.service.create(P({ passportExpiry: 'soon', passportNumber: 'PA1' }))).error, 'invalid passportExpiry');
  assert.equal((await ctx.service.create(P({ identityDocumentType: 'FOO', identityDocumentNumber: 'X' }))).error, 'invalid identityDocumentType');
  const okc = await ctx.service.create(P({ gender: 'FEMALE', email: 'ok@x.com', dateOfBirth: '1990-05-15' }));
  assert.equal(okc.ok, true);
  ctx.db.close();
});

test('EWP-PSVC-4. create: identity pairing (document type needs a number; passport expiry needs a number)', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.create(P({ identityDocumentType: 'PASSPORT' }))).error, 'identityDocumentNumber is required with a document type');
  assert.equal((await ctx.service.create(P({ passportExpiry: '2030-01-01' }))).error, 'passportNumber is required with a passport expiry');
  assert.equal((await ctx.service.create(P({ identityDocumentType: 'PASSPORT', identityDocumentNumber: 'X1', passportNumber: 'PA1', passportExpiry: '2030-01-01' }))).ok, true);
  ctx.db.close();
});

test('EWP-PSVC-5. create: uniqueness on personNumber / email / passport / nationalId', async () => {
  const ctx = await setup();
  await ctx.service.create(P({ personNumber: 'P1', email: 'a@x.com', passportNumber: 'PA1', nationalId: 'N1' }));
  assert.equal((await ctx.service.create(P({ personNumber: 'P1' }))).code, 'CONFLICT');
  assert.equal((await ctx.service.create(P({ email: 'a@x.com' }))).error, 'email already exists');
  assert.equal((await ctx.service.create(P({ passportNumber: 'PA1' }))).error, 'passport already exists');
  assert.equal((await ctx.service.create(P({ nationalId: 'N1' }))).error, 'nationalId already exists');
  ctx.db.close();
});

test('EWP-PSVC-6. update: name validation, format, uniqueness excluding self, success, delegates NOT_FOUND', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.update(9999, { firstName: 'X' })).code, 'NOT_FOUND');
  const a = (await ctx.service.create(P({ email: 'a@x.com' }))).person;
  const b = (await ctx.service.create(P({ firstName: 'Bob', lastName: 'Roe', email: 'b@x.com' }))).person;
  assert.equal((await ctx.service.update(a.id, { firstName: '' })).error, 'firstName must be a non-empty string');
  assert.equal((await ctx.service.update(a.id, { lastName: '  ' })).error, 'lastName must be a non-empty string');
  assert.equal((await ctx.service.update(a.id, { email: 'bad' })).error, 'invalid email');
  assert.equal((await ctx.service.update(a.id, { email: 'b@x.com' })).code, 'CONFLICT', 'email taken by b');
  assert.equal((await ctx.service.update(a.id, { email: 'a@x.com' })).ok, true, 'own email allowed');
  const upd = await ctx.service.update(a.id, { email: 'a2@x.com', preferredName: 'Janie' });
  assert.equal(upd.person.email, 'a2@x.com');
  assert.equal(upd.person.preferredName, 'Janie');
  assert.ok(b.id);
  ctx.db.close();
});

test('EWP-PSVC-7. CRUD delegation: get / list / listActive / archive / restore / remove', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({}))).person;
  assert.equal((await ctx.service.get(c.id)).person.firstName, 'Jane');
  assert.equal((await ctx.service.get(9999)).code, 'NOT_FOUND');
  await ctx.service.create(P({ firstName: 'Bob', lastName: 'Roe' }));
  assert.equal((await ctx.service.list({ lastName: 'Doe' })).persons.length, 1);
  assert.equal((await ctx.service.listActive()).persons.length, 2);
  assert.equal((await ctx.service.archive(c.id)).person.archived, 1);
  assert.deepEqual(await ctx.service.remove(c.id), { ok: true, id: c.id });
  assert.equal((await ctx.service.restore(c.id)).person.deleted, 0);
  ctx.db.close();
});

test('EWP-PSVC-8. lookups: byUuid / byPersonNumber / byPassport / byNationalId / byEmail (found / missing / blank)', async () => {
  const ctx = await setup();
  await ctx.service.create(P({ personNumber: 'P9', email: 'e@x.com', passportNumber: 'PP9', nationalId: 'NN9' }));
  assert.equal((await ctx.service.findByUuid('u-1')).person.firstName, 'Jane');
  assert.equal((await ctx.service.findByPersonNumber('P9')).person.personNumber, 'P9');
  assert.equal((await ctx.service.findByPassport('PP9')).person.passportNumber, 'PP9');
  assert.equal((await ctx.service.findByNationalId('NN9')).person.nationalId, 'NN9');
  assert.equal((await ctx.service.findByEmail('e@x.com')).person.email, 'e@x.com');
  assert.equal((await ctx.service.findByEmail('none@x.com')).code, 'NOT_FOUND');
  assert.equal((await ctx.service.findByEmail('')).error, 'email is required');
  assert.equal((await ctx.service.findByUuid(undefined)).error, 'uuid is required');
  ctx.db.close();
});

test('EWP-PSVC-9. search returns exact-match filtered persons', async () => {
  const ctx = await setup();
  await ctx.service.create(P({ nationality: 'AU' }));
  await ctx.service.create(P({ firstName: 'Bob', lastName: 'Roe', nationality: 'AU' }));
  await ctx.service.create(P({ firstName: 'Cy', lastName: 'Poe', nationality: 'NZ' }));
  assert.equal((await ctx.service.search({ nationality: 'AU' })).persons.length, 2);
  assert.equal((await ctx.service.search({ lastName: 'Doe' })).persons.length, 1);
  ctx.db.close();
});

test('EWP-PSVC-10. detectDuplicates: by email / passport / nationalId / name+dob; union dedup; empty', async () => {
  const ctx = await setup();
  await ctx.service.create(P({ email: 'd@x.com', passportNumber: 'DP1', nationalId: 'DN1', dateOfBirth: '1990-05-15' }));
  assert.equal((await ctx.service.detectDuplicates({ email: 'd@x.com' })).duplicates.length, 1);
  assert.equal((await ctx.service.detectDuplicates({ passportNumber: 'DP1' })).duplicates.length, 1);
  assert.equal((await ctx.service.detectDuplicates({ nationalId: 'DN1' })).duplicates.length, 1);
  assert.equal((await ctx.service.detectDuplicates({ firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-05-15' })).duplicates.length, 1);
  // union across all signals still returns the single person once
  assert.equal((await ctx.service.detectDuplicates({ email: 'd@x.com', passportNumber: 'DP1', nationalId: 'DN1', firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-05-15' })).duplicates.length, 1);
  assert.deepEqual((await ctx.service.detectDuplicates({})).duplicates, [], 'no signals → none');
  assert.deepEqual((await ctx.service.detectDuplicates('nope')).duplicates, []);
  ctx.db.close();
});

test('EWP-PSVC-11. getAge: not-found / injected asOf / default referenceDate / null when no dob', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.getAge(9999)).code, 'NOT_FOUND');
  const withDob = (await ctx.service.create(P({ dateOfBirth: '1990-05-15' }))).person;
  assert.equal((await ctx.service.getAge(withDob.id)).age, 36, 'as of injected referenceDate 2026-07-09');
  assert.equal((await ctx.service.getAge(withDob.id, '2020-01-01')).age, 29);
  const noDob = (await ctx.service.create(P({ firstName: 'No', lastName: 'Dob' }))).person;
  assert.equal((await ctx.service.getAge(noDob.id)).age, null);
  ctx.db.close();
});

test('EWP-PSVC-12. scope validation is active only when an organisation registry is injected', async () => {
  const noOrg = await setup(false);
  assert.equal((await noOrg.service.create(P({ companyId: 99999 }))).ok, true, 'no org registry → scope not validated');
  noOrg.db.close();
  const ctx = await setup(true);
  assert.equal((await ctx.service.create(P({ companyId: ctx.orgIds.companyId, siteId: ctx.orgIds.siteId }))).ok, true);
  assert.equal((await ctx.service.create(P({ companyId: 0 }))).error, 'companyId must be a positive integer');
  assert.equal((await ctx.service.create(P({ companyId: 99999 }))).error, 'company not found');
  assert.equal((await ctx.service.create(P({ siteId: 0 }))).error, 'siteId must be a positive integer');
  assert.equal((await ctx.service.create(P({ siteId: 99999 }))).error, 'site not found');
  ctx.db.close();
});

test('EWP-PSVC-12b. a new person is active and not archived/deleted', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({}))).person;
  assert.equal(c.active, 1);
  assert.equal(c.archived, 0);
  assert.equal(c.deleted, 0);
  ctx.db.close();
});

test('EWP-PSVC-12c. list excludes soft-deleted; archived persons remain findable by lookup', async () => {
  const ctx = await setup();
  const a = (await ctx.service.create(P({ email: 'a@x.com' }))).person;
  const b = (await ctx.service.create(P({ firstName: 'Bob', lastName: 'Roe', email: 'b@x.com' }))).person;
  await ctx.service.archive(a.id);
  assert.equal((await ctx.service.findByEmail('a@x.com')).person.archived, 1, 'archived still findable');
  await ctx.service.remove(b.id);
  assert.equal((await ctx.service.list({})).persons.length, 1, 'deleted excluded from list');
  ctx.db.close();
});

test('EWP-PSVC-12d. duplicate detection by a single passport or nationalId signal', async () => {
  const ctx = await setup();
  await ctx.service.create(P({ passportNumber: 'ZZ1' }));
  await ctx.service.create(P({ firstName: 'Bo', lastName: 'Ro', nationalId: 'ZN1' }));
  assert.equal((await ctx.service.detectDuplicates({ passportNumber: 'ZZ1' })).duplicates.length, 1);
  assert.equal((await ctx.service.detectDuplicates({ nationalId: 'ZN1' })).duplicates.length, 1);
  assert.equal((await ctx.service.detectDuplicates({ passportNumber: 'MISSING' })).duplicates.length, 0);
  ctx.db.close();
});

test('EWP-PSVC-12e. scope columns (tenantId/companyId/siteId) persist on create', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({ tenantId: 1, companyId: 2, siteId: 3 }))).person;
  assert.equal(c.tenantId, 1);
  assert.equal(c.companyId, 2);
  assert.equal(c.siteId, 3);
  ctx.db.close();
});

test('EWP-PSVC-12f. update does not enforce create-only identity pairing', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({}))).person;
  // setting a document type without a number is allowed on update (pairing is create-only)
  assert.equal((await ctx.service.update(c.id, { identityDocumentType: 'MEDICARE' })).ok, true);
  ctx.db.close();
});

test('EWP-PSVC-12g. search by primaryLanguage', async () => {
  const ctx = await setup();
  await ctx.service.create(P({ primaryLanguage: 'EN' }));
  await ctx.service.create(P({ firstName: 'Bo', lastName: 'Ro', primaryLanguage: 'ES' }));
  assert.equal((await ctx.service.search({ primaryLanguage: 'EN' })).persons.length, 1);
  ctx.db.close();
});

test('EWP-PSVC-13. never-throw: a repository failure is caught and returned as ERROR', async () => {
  const boom = () => { throw new Error('db down'); };
  const brokenRepo = { create: boom, findById: boom, findBy: boom, findAll: boom, findActive: boom, update() {}, archive() {}, restore() {}, softDelete() {}, exists() {} };
  const svc = createPersonService(brokenRepo, { uuid: () => 'x', referenceDate: '2026-01-01' });
  assert.equal((await svc.findByEmail('e@x.com')).code, 'ERROR');
  assert.equal((await svc.search({})).code, 'ERROR');
  assert.equal((await svc.detectDuplicates({ email: 'e@x.com' })).code, 'ERROR');
  assert.equal((await svc.getAge(1)).code, 'ERROR');
});

test('EWP-PSVC-14. calculateAge is pure: birthday boundaries, future dob, and malformed dates → null', () => {
  assert.equal(calculateAge('1990-05-15', '2026-05-15'), 36, 'on the birthday');
  assert.equal(calculateAge('1990-05-15', '2026-05-14'), 35, 'day before');
  assert.equal(calculateAge('1990-05-15', '2026-04-30'), 35, 'earlier month');
  assert.equal(calculateAge('2030-01-01', '2026-01-01'), null, 'future dob');
  assert.equal(calculateAge('bad', '2026-01-01'), null);
  assert.equal(calculateAge('2026-01-01', 'bad'), null);
  assert.equal(calculateAge(123, '2026-01-01'), null, 'non-string dob');
  assert.equal(calculateAge('1990-01-01', 123), null, 'non-string asOf');
  assert.equal(calculateAge('1990-01-01', null), null, 'null asOf');
  assert.equal(calculateAge('2026-00-15', '2026-06-01'), null, 'month < 1');
  assert.equal(calculateAge('2026-13-15', '2026-06-01'), null, 'month > 12');
  assert.equal(calculateAge('2026-05-00', '2026-06-01'), null, 'day < 1');
  assert.equal(calculateAge('2026-05-32', '2026-06-01'), null, 'day > 31');
});

test('EWP-PSVC-15. exported enum vocabularies', () => {
  assert.deepEqual(GENDERS, ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED']);
  assert.ok(ID_TYPES.includes('PASSPORT') && ID_TYPES.includes('NATIONAL_ID'));
});

test('EWP-PSVC-16. all identity fields and metadata round-trip through create', async () => {
  const ctx = await setup();
  const c = await ctx.service.create(P({
    title: 'Ms', middleName: 'Q', preferredName: 'Janie', gender: 'FEMALE', dateOfBirth: '1990-05-15',
    nationality: 'AU', primaryLanguage: 'EN', secondaryLanguage: 'FR', email: 'j@x.com', mobile: '0400',
    alternatePhone: '0800', emergencyContactName: 'Kin', emergencyContactPhone: '0411', emergencyContactRelationship: 'Sister',
    identityDocumentType: 'DRIVERS_LICENCE', identityDocumentNumber: 'DL1', passportNumber: 'PA1', passportExpiry: '2031-01-01',
    nationalId: 'N1', photoUrl: 'http://p', signatureUrl: 'http://s', metadata: { source: 'HR' },
  }));
  assert.equal(c.ok, true);
  assert.equal(c.person.title, 'Ms');
  assert.equal(c.person.secondaryLanguage, 'FR');
  assert.equal(c.person.emergencyContactRelationship, 'Sister');
  assert.equal(c.person.photoUrl, 'http://p');
  assert.deepEqual(c.person.metadata, { source: 'HR' });
  ctx.db.close();
});

test('EWP-PSVC-17. uuid and personNumber are immutable on update', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({ personNumber: 'P1' }))).person;
  const upd = await ctx.service.update(c.id, { personNumber: 'P999', uuid: 'hacked', preferredName: 'J' });
  assert.equal(upd.person.personNumber, 'P1', 'personNumber not updatable');
  assert.equal(upd.person.uuid, c.uuid, 'uuid not updatable');
  assert.equal(upd.person.preferredName, 'J');
  ctx.db.close();
});

test('EWP-PSVC-18. every gender and every identity-document type is accepted', async () => {
  const ctx = await setup();
  let i = 0;
  for (const g of GENDERS) {
    assert.equal((await ctx.service.create(P({ firstName: `G${i}`, lastName: 'X', gender: g }))).ok, true, g);
    i += 1;
  }
  for (const t of ID_TYPES) {
    assert.equal((await ctx.service.create(P({ firstName: `T${i}`, lastName: 'X', identityDocumentType: t, identityDocumentNumber: `D${i}` }))).ok, true, t);
    i += 1;
  }
  ctx.db.close();
});

test('EWP-PSVC-19. update: format validation on gender / dateOfBirth / passportExpiry / identityDocumentType', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({}))).person;
  assert.equal((await ctx.service.update(c.id, { gender: 'ZZ' })).error, 'invalid gender');
  assert.equal((await ctx.service.update(c.id, { dateOfBirth: '01-01-2000' })).error, 'invalid dateOfBirth');
  assert.equal((await ctx.service.update(c.id, { passportExpiry: 'never' })).error, 'invalid passportExpiry');
  assert.equal((await ctx.service.update(c.id, { identityDocumentType: 'ZZ' })).error, 'invalid identityDocumentType');
  assert.equal((await ctx.service.update(c.id, { gender: 'OTHER', dateOfBirth: '2000-01-01' })).ok, true);
  ctx.db.close();
});

test('EWP-PSVC-20. update: scope re-validated when an organisation registry is injected', async () => {
  const ctx = await setup(true);
  const c = (await ctx.service.create(P({}))).person;
  assert.equal((await ctx.service.update(c.id, { companyId: 99999 })).error, 'company not found');
  assert.equal((await ctx.service.update(c.id, { siteId: 99999 })).error, 'site not found');
  assert.equal((await ctx.service.update(c.id, { companyId: ctx.orgIds.companyId, siteId: ctx.orgIds.siteId })).ok, true);
  ctx.db.close();
});

test('EWP-PSVC-21. lookups: not-found and blank-value variants across every key', async () => {
  const ctx = await setup();
  assert.equal((await ctx.service.findByPersonNumber('NOPE')).code, 'NOT_FOUND');
  assert.equal((await ctx.service.findByPassport('')).error, 'passportNumber is required');
  assert.equal((await ctx.service.findByNationalId(undefined)).error, 'nationalId is required');
  assert.equal((await ctx.service.findByPersonNumber('')).error, 'personNumber is required');
  ctx.db.close();
});

test('EWP-PSVC-22. search with no criteria returns all persons; detectDuplicates name needs first+last+dob', async () => {
  const ctx = await setup();
  await ctx.service.create(P({}));
  await ctx.service.create(P({ firstName: 'Bob', lastName: 'Roe' }));
  assert.equal((await ctx.service.search({})).persons.length, 2);
  // name signal ignored unless all three of first/last/dob present
  assert.deepEqual((await ctx.service.detectDuplicates({ firstName: 'Jane', lastName: 'Doe' })).duplicates, [], 'no dob → name signal skipped');
  ctx.db.close();
});

test('EWP-PSVC-23. getAge echoes the effective asOf (injected default and explicit)', async () => {
  const ctx = await setup();
  const c = (await ctx.service.create(P({ dateOfBirth: '2000-01-01' }))).person;
  const def = await ctx.service.getAge(c.id);
  assert.equal(def.asOf, '2026-07-09');
  assert.equal(def.age, 26);
  const explicit = await ctx.service.getAge(c.id, '2010-01-01');
  assert.equal(explicit.asOf, '2010-01-01');
  assert.equal(explicit.age, 10);
  ctx.db.close();
});
