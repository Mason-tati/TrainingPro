// WP-26 · Phase 14 — Enterprise Document Engine — Training Program — Service.
//
// Business orchestration over an INJECTED training-program repository (reusing the certified BaseService)
// plus FIVE READ-ONLY injected repositories — the WP-26 Phase 8 competency repository, the Phase 9
// assessment repository, the Phase 7 training-assignment repository, the Phase 12 employee competency
// profile repository, and the Phase 13 competency recertification repository. The competency and
// assessment repositories validate that a program's certified competency / assessment exist; the
// remaining three are held read-only for downstream integration (a program spawns assignments, drives
// profiles, and schedules recertifications) and are never mutated. Enforces: program-code uniqueness,
// competency/assessment existence, trainer/owner validation, training-type / delivery-method / status
// validation, mandatory & renewal validation, effective/expiry ordering, and metadata validation. NO
// controller/HTTP logic and NO SQL. Stateless, deterministic (dates stamped by the repository/SQLite;
// ordering is a pure string compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByProgramCode', 'findByCompetency', 'findByTrainer', 'findMandatory', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const TRAINING_TYPES = ['INDUCTION', 'REFRESHER', 'REGULATORY', 'TECHNICAL', 'SAFETY', 'LEADERSHIP', 'ONBOARDING'];
const DELIVERY_METHODS = ['CLASSROOM', 'ONLINE', 'BLENDED', 'ON_THE_JOB', 'SELF_STUDY', 'WEBINAR'];
const STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'];
// Content fields settable via updateProgram (programCode is the immutable business key).
const UPDATABLE_FIELDS = [
  'programName', 'description', 'trainingType', 'deliveryMethod', 'department', 'site', 'businessUnit',
  'ownerId', 'trainerId', 'competencyId', 'assessmentId', 'durationHours', 'renewalPeriodMonths',
  'mandatory', 'status', 'effectiveDate', 'expiryDate',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isBinaryFlag(value) {
  return value === 0 || value === 1;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(program) {
  let metadata = null;
  try {
    metadata = program.metadataJson ? JSON.parse(program.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, program, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseTrainingProgramService extends BaseService {
  constructor(repository, competencyRepository, assessmentRepository, trainingAssignmentRepository, profileRepository, recertificationRepository) {
    super(repository, REPOSITORY_METHODS);
    const deps = [
      ['competency', competencyRepository], ['assessment', assessmentRepository],
      ['training assignment', trainingAssignmentRepository], ['profile', profileRepository],
      ['recertification', recertificationRepository],
    ];
    for (const [name, repo] of deps) {
      if (!repo || typeof repo.findById !== 'function') {
        throw new Error(`EnterpriseTrainingProgramService requires an injected ${name} repository with findById()`);
      }
    }
    this.competencyRepository = competencyRepository;
    this.assessmentRepository = assessmentRepository;
    this.trainingAssignmentRepository = trainingAssignmentRepository;
    this.profileRepository = profileRepository;
    this.recertificationRepository = recertificationRepository;
  }

  // Validate the domain references (competency/assessment existence) and the trainer/owner ids. Returns
  // an invalid() result, or null when all supplied values are OK.
  async validateReferences(src) {
    if (src.competencyId !== undefined && src.competencyId !== null) {
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId must be a positive integer', 'VALIDATION');
      if (!(await this.competencyRepository.findById(src.competencyId))) return invalid('competency not found', 'VALIDATION');
    }
    if (src.assessmentId !== undefined && src.assessmentId !== null) {
      if (!isPositiveInteger(src.assessmentId)) return invalid('assessmentId must be a positive integer', 'VALIDATION');
      if (!(await this.assessmentRepository.findById(src.assessmentId))) return invalid('assessment not found', 'VALIDATION');
    }
    if (src.trainerId !== undefined && !isPositiveInteger(src.trainerId)) return invalid('trainerId must be a positive integer', 'VALIDATION');
    if (src.ownerId !== undefined && !isPositiveInteger(src.ownerId)) return invalid('ownerId must be a positive integer', 'VALIDATION');
    return null;
  }

  // Validate the classification / numeric / metadata fields shared by create and update. Returns
  // invalid() or null.
  validateClassification(src) {
    if (src.trainingType !== undefined && !TRAINING_TYPES.includes(src.trainingType)) return invalid('invalid trainingType', 'VALIDATION');
    if (src.deliveryMethod !== undefined && !DELIVERY_METHODS.includes(src.deliveryMethod)) return invalid('invalid deliveryMethod', 'VALIDATION');
    if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
    if (src.mandatory !== undefined && !isBinaryFlag(src.mandatory)) return invalid('mandatory must be 0 or 1', 'VALIDATION');
    if (src.durationHours !== undefined && !isNonNegativeNumber(src.durationHours)) return invalid('durationHours must be a non-negative number', 'VALIDATION');
    if (src.renewalPeriodMonths !== undefined && !isPositiveInteger(src.renewalPeriodMonths)) return invalid('renewalPeriodMonths must be a positive integer', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Register a training program. programCode must be unique among non-deleted programs; any supplied
  // competency/assessment must exist.
  createProgram(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.programCode)) return invalid('programCode is required', 'VALIDATION');
      if (!isNonEmptyString(src.programName)) return invalid('programName is required', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const effectiveDate = pick(src, 'effectiveDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) return invalid('expiryDate must be on or after effectiveDate', 'VALIDATION');

      const existing = await this.repository.findByProgramCode(src.programCode);
      if (existing) return invalid('programCode already exists', 'CONFLICT');

      const payload = {
        programCode: src.programCode,
        programName: src.programName,
        description: pick(src, 'description', null),
        trainingType: pick(src, 'trainingType', null),
        deliveryMethod: pick(src, 'deliveryMethod', null),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        ownerId: pick(src, 'ownerId', null),
        trainerId: pick(src, 'trainerId', null),
        competencyId: pick(src, 'competencyId', null),
        assessmentId: pick(src, 'assessmentId', null),
        durationHours: pick(src, 'durationHours', null),
        renewalPeriodMonths: pick(src, 'renewalPeriodMonths', null),
        mandatory: pick(src, 'mandatory', 0),
        status: pick(src, 'status', 'DRAFT'),
        effectiveDate,
        expiryDate,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const program = await this.repository.create(payload);
      return { ok: true, program: withMetadata(program) };
    });
  }

  updateProgram(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('program not found', 'NOT_FOUND');
      if (src.programName !== undefined && !isNonEmptyString(src.programName)) return invalid('programName must be a non-empty string', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const effectiveDate = pick(src, 'effectiveDate', current.effectiveDate);
      const expiryDate = pick(src, 'expiryDate', current.expiryDate);
      if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) return invalid('expiryDate must be on or after effectiveDate', 'VALIDATION');

      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const program = await this.repository.update(id, payload);
      return { ok: true, program: withMetadata(program) };
    });
  }

  getProgram(id) {
    return execute(async () => {
      const program = await this.repository.findById(id);
      if (!program) return invalid('program not found', 'NOT_FOUND');
      return { ok: true, program: withMetadata(program) };
    });
  }

  listCompetencyPrograms(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, programs: rows.map((p) => withMetadata(p)) };
    });
  }

  listTrainerPrograms(trainerId) {
    return execute(async () => {
      const rows = await this.repository.findByTrainer(trainerId);
      return { ok: true, programs: rows.map((p) => withMetadata(p)) };
    });
  }

  mandatoryPrograms() {
    return execute(async () => {
      const rows = await this.repository.findMandatory();
      return { ok: true, programs: rows.map((p) => withMetadata(p)) };
    });
  }

  activePrograms() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, programs: rows.map((p) => withMetadata(p)) };
    });
  }

  archiveProgram(id) {
    return execute(async () => {
      const program = await this.repository.findById(id);
      if (!program) return invalid('program not found', 'NOT_FOUND');
      if (program.archived) return invalid('program already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, program: withMetadata(updated) };
    });
  }

  deleteProgram(id) {
    return execute(async () => {
      const program = await this.repository.findById(id);
      if (!program) return invalid('program not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreProgram(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('program not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const program = await this.repository.findById(id);
      return { ok: true, program: withMetadata(program) };
    });
  }
}

module.exports = EnterpriseTrainingProgramService;
