// WP-26 · Phase 16 — Enterprise Document Engine — Qualification — Service.
//
// Business orchestration over an INJECTED qualification repository (reusing the certified BaseService)
// plus FIVE READ-ONLY injected repositories — the WP-26 Phase 15 learning-path repository, the Phase 14
// training-program repository, the Phase 8 competency repository, the Phase 12 employee competency
// profile repository, and the Phase 13 competency recertification repository. The learning-path and
// competency repositories validate that a qualification's learning path / competency exist; the
// remaining three are held read-only for downstream integration and are never mutated. Enforces:
// qualification-code uniqueness, learning-path / competency existence, role validation, qualification-
// type validation, validity-period validation, renewal & mandatory validation, status validation,
// effective/expiry ordering, and metadata validation. NO controller/HTTP logic and NO SQL. Stateless,
// deterministic (dates stamped by the repository/SQLite; ordering is a pure string compare), never-throw,
// copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByQualificationCode', 'findByRole', 'findByLearningPath', 'findByCompetency', 'findMandatory', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const QUALIFICATION_TYPES = ['CERTIFICATION', 'LICENSE', 'ACCREDITATION', 'TICKET', 'ENDORSEMENT'];
const STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'];
// Content fields settable via updateQualification (qualificationCode is the immutable business key).
const UPDATABLE_FIELDS = [
  'qualificationName', 'description', 'department', 'site', 'businessUnit', 'roleId', 'learningPathId',
  'competencyId', 'qualificationType', 'validityMonths', 'renewalRequired', 'mandatory', 'status',
  'effectiveDate', 'expiryDate',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
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
function withMetadata(qualification) {
  let metadata = null;
  try {
    metadata = qualification.metadataJson ? JSON.parse(qualification.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, qualification, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseQualificationService extends BaseService {
  constructor(repository, learningPathRepository, trainingProgramRepository, competencyRepository, profileRepository, recertificationRepository) {
    super(repository, REPOSITORY_METHODS);
    const deps = [
      ['learning path', learningPathRepository], ['training program', trainingProgramRepository],
      ['competency', competencyRepository], ['profile', profileRepository],
      ['recertification', recertificationRepository],
    ];
    for (const [name, repo] of deps) {
      if (!repo || typeof repo.findById !== 'function') {
        throw new Error(`EnterpriseQualificationService requires an injected ${name} repository with findById()`);
      }
    }
    this.learningPathRepository = learningPathRepository;
    this.trainingProgramRepository = trainingProgramRepository;
    this.competencyRepository = competencyRepository;
    this.profileRepository = profileRepository;
    this.recertificationRepository = recertificationRepository;
  }

  // Validate the domain references (learning-path / competency existence) and the role id. Returns an
  // invalid() result, or null when all supplied values are OK.
  async validateReferences(src) {
    if (src.learningPathId !== undefined && src.learningPathId !== null) {
      if (!isPositiveInteger(src.learningPathId)) return invalid('learningPathId must be a positive integer', 'VALIDATION');
      if (!(await this.learningPathRepository.findById(src.learningPathId))) return invalid('learning path not found', 'VALIDATION');
    }
    if (src.competencyId !== undefined && src.competencyId !== null) {
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId must be a positive integer', 'VALIDATION');
      if (!(await this.competencyRepository.findById(src.competencyId))) return invalid('competency not found', 'VALIDATION');
    }
    if (src.roleId !== undefined && !isPositiveInteger(src.roleId)) return invalid('roleId must be a positive integer', 'VALIDATION');
    return null;
  }

  // Validate the classification / numeric / metadata fields shared by create and update. Returns
  // invalid() or null.
  validateClassification(src) {
    if (src.qualificationType !== undefined && !QUALIFICATION_TYPES.includes(src.qualificationType)) return invalid('invalid qualificationType', 'VALIDATION');
    if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
    if (src.renewalRequired !== undefined && !isBinaryFlag(src.renewalRequired)) return invalid('renewalRequired must be 0 or 1', 'VALIDATION');
    if (src.mandatory !== undefined && !isBinaryFlag(src.mandatory)) return invalid('mandatory must be 0 or 1', 'VALIDATION');
    if (src.validityMonths !== undefined && !isPositiveInteger(src.validityMonths)) return invalid('validityMonths must be a positive integer', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Register a qualification. qualificationCode must be unique among non-deleted qualifications; any
  // supplied learning path / competency must exist.
  createQualification(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.qualificationCode)) return invalid('qualificationCode is required', 'VALIDATION');
      if (!isNonEmptyString(src.qualificationName)) return invalid('qualificationName is required', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const effectiveDate = pick(src, 'effectiveDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) return invalid('expiryDate must be on or after effectiveDate', 'VALIDATION');

      const existing = await this.repository.findByQualificationCode(src.qualificationCode);
      if (existing) return invalid('qualificationCode already exists', 'CONFLICT');

      const payload = {
        qualificationCode: src.qualificationCode,
        qualificationName: src.qualificationName,
        description: pick(src, 'description', null),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        roleId: pick(src, 'roleId', null),
        learningPathId: pick(src, 'learningPathId', null),
        competencyId: pick(src, 'competencyId', null),
        qualificationType: pick(src, 'qualificationType', null),
        validityMonths: pick(src, 'validityMonths', null),
        renewalRequired: pick(src, 'renewalRequired', 0),
        mandatory: pick(src, 'mandatory', 0),
        status: pick(src, 'status', 'DRAFT'),
        effectiveDate,
        expiryDate,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const qualification = await this.repository.create(payload);
      return { ok: true, qualification: withMetadata(qualification) };
    });
  }

  updateQualification(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('qualification not found', 'NOT_FOUND');
      if (src.qualificationName !== undefined && !isNonEmptyString(src.qualificationName)) return invalid('qualificationName must be a non-empty string', 'VALIDATION');
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
      const qualification = await this.repository.update(id, payload);
      return { ok: true, qualification: withMetadata(qualification) };
    });
  }

  getQualification(id) {
    return execute(async () => {
      const qualification = await this.repository.findById(id);
      if (!qualification) return invalid('qualification not found', 'NOT_FOUND');
      return { ok: true, qualification: withMetadata(qualification) };
    });
  }

  listRoleQualifications(roleId) {
    return execute(async () => {
      const rows = await this.repository.findByRole(roleId);
      return { ok: true, qualifications: rows.map((q) => withMetadata(q)) };
    });
  }

  listLearningPathQualifications(learningPathId) {
    return execute(async () => {
      const rows = await this.repository.findByLearningPath(learningPathId);
      return { ok: true, qualifications: rows.map((q) => withMetadata(q)) };
    });
  }

  listCompetencyQualifications(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, qualifications: rows.map((q) => withMetadata(q)) };
    });
  }

  mandatoryQualifications() {
    return execute(async () => {
      const rows = await this.repository.findMandatory();
      return { ok: true, qualifications: rows.map((q) => withMetadata(q)) };
    });
  }

  activeQualifications() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, qualifications: rows.map((q) => withMetadata(q)) };
    });
  }

  archiveQualification(id) {
    return execute(async () => {
      const qualification = await this.repository.findById(id);
      if (!qualification) return invalid('qualification not found', 'NOT_FOUND');
      if (qualification.archived) return invalid('qualification already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, qualification: withMetadata(updated) };
    });
  }

  deleteQualification(id) {
    return execute(async () => {
      const qualification = await this.repository.findById(id);
      if (!qualification) return invalid('qualification not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreQualification(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('qualification not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const qualification = await this.repository.findById(id);
      return { ok: true, qualification: withMetadata(qualification) };
    });
  }
}

module.exports = EnterpriseQualificationService;
