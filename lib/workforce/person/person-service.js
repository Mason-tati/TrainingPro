// EWP-01c — Enterprise Workforce Platform — Person & Identity — Service.
//
// Business orchestration over the Person repository. CRUD (create/update/get/list/archive/restore/remove)
// is delegated to an EWP-01a generic-lifecycle-service (never-throw + copy-on-read reused, NOT
// re-implemented); this service adds the Person-specific capabilities: identity validation, uniqueness /
// duplicate detection, the lookups (by uuid / personNumber / passport / nationalId / email), person
// search, and a pure age calculation. uuid is server-generated (injectable generator, default
// node:crypto.randomUUID); uuid + personNumber are immutable. When an EWP-01b organisation registry is
// injected, a person's companyId / siteId scope is validated against the certified org hierarchy
// (reusing EWP-01b). Never-throw, deterministic (age is a pure function of the two dates), copy-on-read.
// UNWIRED.
'use strict';

const { randomUUID } = require('node:crypto');
const { createService } = require('../generic-lifecycle-service');
const V = require('../shared-validation');

const GENDERS = ['MALE', 'FEMALE', 'OTHER', 'UNSPECIFIED'];
const ID_TYPES = ['PASSPORT', 'DRIVERS_LICENCE', 'NATIONAL_ID', 'MEDICARE', 'OTHER'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Identity fields that must be unique across non-deleted persons (duplicate detection).
const UNIQUE_FIELDS = [
  { field: 'personNumber', message: 'personNumber already exists' },
  { field: 'email', message: 'email already exists' },
  { field: 'passportNumber', message: 'passport already exists' },
  { field: 'nationalId', message: 'nationalId already exists' },
];

async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

// Parse a strict 'YYYY-MM-DD' string into [year, month, day], or null when malformed.
function parseYmd(value) {
  if (!DATE_RE.test(value)) return null;
  const parts = value.split('-').map((n) => Number(n));
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31) return null;
  return parts;
}

// Pure, deterministic age in whole years between a date of birth and a reference date. Returns null when
// either date is malformed or the date of birth is after the reference date.
function calculateAge(dateOfBirth, asOfDate) {
  const dob = typeof dateOfBirth === 'string' ? parseYmd(dateOfBirth) : null;
  const asOf = typeof asOfDate === 'string' ? parseYmd(asOfDate) : null;
  if (!dob || !asOf) return null;
  let age = asOf[0] - dob[0];
  if (asOf[1] < dob[1] || (asOf[1] === dob[1] && asOf[2] < dob[2])) age -= 1;
  return age < 0 ? null : age;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

class PersonService {
  constructor(repository, options) {
    if (!repository || typeof repository.create !== 'function' || typeof repository.findById !== 'function') {
      throw new Error('PersonService requires a person repository');
    }
    const opts = V.isPlainObject(options) ? options : {};
    this.repository = repository;
    this.uuidFn = typeof opts.uuid === 'function' ? opts.uuid : randomUUID;
    this.organisationRegistry = (opts.organisationRegistry && typeof opts.organisationRegistry.get === 'function') ? opts.organisationRegistry : null;
    this.referenceDate = V.isNonEmptyString(opts.referenceDate) ? opts.referenceDate : todayIso();
    this._crud = createService(repository, {
      resourceKey: 'person',
      collectionKey: 'persons',
      validateCreate: (input) => this._validateCreate(input),
      validateUpdate: (patch, current) => this._validateUpdate(patch, current),
    });
  }

  // ---- validation ----
  _validateFormats(src) {
    if (src.gender !== undefined && !V.isInSet(src.gender, GENDERS)) return V.invalid('invalid gender');
    if (src.email !== undefined && !EMAIL_RE.test(String(src.email))) return V.invalid('invalid email');
    if (src.dateOfBirth !== undefined && !DATE_RE.test(String(src.dateOfBirth))) return V.invalid('invalid dateOfBirth');
    if (src.passportExpiry !== undefined && !DATE_RE.test(String(src.passportExpiry))) return V.invalid('invalid passportExpiry');
    if (src.identityDocumentType !== undefined && !V.isInSet(src.identityDocumentType, ID_TYPES)) return V.invalid('invalid identityDocumentType');
    return null;
  }

  async _checkUnique(src, currentId) {
    for (const u of UNIQUE_FIELDS) {
      if (V.isNonEmptyString(src[u.field])) {
        const rows = await this.repository.findBy(u.field, src[u.field]);
        if (rows.some((r) => currentId === null || r.id !== currentId)) return V.invalid(u.message, 'CONFLICT');
      }
    }
    return null;
  }

  async _validateScope(src) {
    if (!this.organisationRegistry) return null;
    if (src.companyId !== undefined && src.companyId !== null) {
      if (!V.isPositiveInteger(src.companyId)) return V.invalid('companyId must be a positive integer');
      if (!(await this.organisationRegistry.get('COMPANY').findById(src.companyId))) return V.invalid('company not found');
    }
    if (src.siteId !== undefined && src.siteId !== null) {
      if (!V.isPositiveInteger(src.siteId)) return V.invalid('siteId must be a positive integer');
      if (!(await this.organisationRegistry.get('SITE').findById(src.siteId))) return V.invalid('site not found');
    }
    return null;
  }

  async _validateCreate(input) {
    if (!V.isNonEmptyString(input.firstName)) return V.invalid('firstName is required');
    if (!V.isNonEmptyString(input.lastName)) return V.invalid('lastName is required');
    const fmt = this._validateFormats(input);
    if (fmt) return fmt;
    // create-only identity pairing
    if (input.identityDocumentType !== undefined && !V.isNonEmptyString(input.identityDocumentNumber)) return V.invalid('identityDocumentNumber is required with a document type');
    if (input.passportExpiry !== undefined && !V.isNonEmptyString(input.passportNumber)) return V.invalid('passportNumber is required with a passport expiry');
    const uniq = await this._checkUnique(input, null);
    if (uniq) return uniq;
    return this._validateScope(input);
  }

  async _validateUpdate(patch, current) {
    if (patch.firstName !== undefined && !V.isNonEmptyString(patch.firstName)) return V.invalid('firstName must be a non-empty string');
    if (patch.lastName !== undefined && !V.isNonEmptyString(patch.lastName)) return V.invalid('lastName must be a non-empty string');
    const fmt = this._validateFormats(patch);
    if (fmt) return fmt;
    const uniq = await this._checkUnique(patch, current.id);
    if (uniq) return uniq;
    return this._validateScope(patch);
  }

  // ---- CRUD (generic-compatible names so the generic controller can drive them) ----
  create(input) {
    const src = V.isPlainObject(input) ? input : {};
    return this._crud.create(Object.assign({}, src, { uuid: this.uuidFn() }));
  }
  update(id, patch) { return this._crud.update(id, patch); }
  get(id) { return this._crud.get(id); }
  list(filters) { return this._crud.list(filters); }
  listActive() { return this._crud.listActive(); }
  archive(id) { return this._crud.archive(id); }
  restore(id) { return this._crud.restore(id); }
  remove(id) { return this._crud.remove(id); }

  // ---- lookups ----
  _lookup(column, value, label) {
    return execute(async () => {
      if (!V.isNonEmptyString(value)) return V.invalid(`${label} is required`);
      const rows = await this.repository.findBy(column, value);
      if (!rows.length) return V.invalid('person not found', 'NOT_FOUND');
      return V.ok({ person: V.withMetadata(rows[0]) });
    });
  }
  findByUuid(value) { return this._lookup('uuid', value, 'uuid'); }
  findByPersonNumber(value) { return this._lookup('personNumber', value, 'personNumber'); }
  findByPassport(value) { return this._lookup('passportNumber', value, 'passportNumber'); }
  findByNationalId(value) { return this._lookup('nationalId', value, 'nationalId'); }
  findByEmail(value) { return this._lookup('email', value, 'email'); }

  // Exact-match person search over the allow-listed identity/name columns (partial search is a future WP).
  search(criteria) {
    return execute(async () => {
      const rows = await this.repository.findAll(criteria);
      return V.ok({ persons: rows.map((r) => V.withMetadata(r)) });
    });
  }

  // Potential duplicate persons: union of matches on email / passport / nationalId and firstName +
  // lastName + dateOfBirth.
  detectDuplicates(input) {
    return execute(async () => {
      const src = V.isPlainObject(input) ? input : {};
      const found = new Map();
      const add = (rows) => rows.forEach((r) => found.set(r.id, r));
      if (V.isNonEmptyString(src.email)) add(await this.repository.findBy('email', src.email));
      if (V.isNonEmptyString(src.passportNumber)) add(await this.repository.findBy('passportNumber', src.passportNumber));
      if (V.isNonEmptyString(src.nationalId)) add(await this.repository.findBy('nationalId', src.nationalId));
      if (V.isNonEmptyString(src.firstName) && V.isNonEmptyString(src.lastName) && V.isNonEmptyString(src.dateOfBirth)) {
        const byName = await this.repository.findBy('lastName', src.lastName);
        add(byName.filter((r) => r.firstName === src.firstName && r.dateOfBirth === src.dateOfBirth));
      }
      return V.ok({ duplicates: Array.from(found.values()).map((r) => V.withMetadata(r)) });
    });
  }

  // Age of a person in whole years as of a reference date (defaults to the service reference date).
  getAge(id, asOfDate) {
    return execute(async () => {
      const person = await this.repository.findById(id);
      if (!person) return V.invalid('person not found', 'NOT_FOUND');
      const asOf = V.isNonEmptyString(asOfDate) ? asOfDate : this.referenceDate;
      return V.ok({ age: calculateAge(person.dateOfBirth, asOf), asOf });
    });
  }
}

function createPersonService(repository, options) {
  return new PersonService(repository, options);
}

module.exports = { PersonService, createPersonService, calculateAge, GENDERS, ID_TYPES };
