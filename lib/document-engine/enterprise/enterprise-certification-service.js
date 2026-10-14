// WP-26 · Phase 17 — Enterprise Document Engine — Certification — Service.
//
// Business orchestration over an INJECTED certification repository (reusing the certified BaseService)
// plus SIX READ-ONLY injected repositories — the WP-26 Phase 16 qualification repository, the Phase 15
// learning-path repository, the Phase 14 training-program repository, the Phase 8 competency repository,
// the Phase 12 employee competency profile repository, and the Phase 13 competency recertification
// repository. The qualification, learning-path and competency repositories validate that a
// certification's evidenced qualification / learning path / competency exist; the remaining three are
// held read-only for downstream integration and are never mutated. Enforces: certification-code
// uniqueness, qualification / learning-path / competency existence, role validation, issuing-authority
// validation, renewal & status validation, issue/expiry ordering, and metadata validation. NO
// controller/HTTP logic and NO SQL. Stateless, deterministic (dates stamped by the repository/SQLite;
// ordering is a pure string compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByCertificationCode', 'findByQualification', 'findByLearningPath', 'findByCompetency', 'findByRole', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'REVOKED'];
// Content fields settable via updateCertification (certificationCode is the immutable business key).
const UPDATABLE_FIELDS = [
  'certificationName', 'description', 'department', 'site', 'businessUnit', 'roleId', 'qualificationId',
  'learningPathId', 'competencyId', 'issuingAuthority', 'issueDate', 'expiryDate', 'renewalRequired',
  'status',
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
function withMetadata(certification) {
  let metadata = null;
  try {
    metadata = certification.metadataJson ? JSON.parse(certification.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, certification, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseCertificationService extends BaseService {
  constructor(repository, qualificationRepository, learningPathRepository, trainingProgramRepository, competencyRepository, profileRepository, recertificationRepository) {
    super(repository, REPOSITORY_METHODS);
    const deps = [
      ['qualification', qualificationRepository], ['learning path', learningPathRepository],
      ['training program', trainingProgramRepository], ['competency', competencyRepository],
      ['profile', profileRepository], ['recertification', recertificationRepository],
    ];
    for (const [name, repo] of deps) {
      if (!repo || typeof repo.findById !== 'function') {
        throw new Error(`EnterpriseCertificationService requires an injected ${name} repository with findById()`);
      }
    }
    this.qualificationRepository = qualificationRepository;
    this.learningPathRepository = learningPathRepository;
    this.trainingProgramRepository = trainingProgramRepository;
    this.competencyRepository = competencyRepository;
    this.profileRepository = profileRepository;
    this.recertificationRepository = recertificationRepository;
  }

  // Validate the domain references (qualification / learning-path / competency existence), the role id,
  // and the issuing authority. Returns an invalid() result, or null when all supplied values are OK.
  async validateReferences(src) {
    if (src.qualificationId !== undefined && src.qualificationId !== null) {
      if (!isPositiveInteger(src.qualificationId)) return invalid('qualificationId must be a positive integer', 'VALIDATION');
      if (!(await this.qualificationRepository.findById(src.qualificationId))) return invalid('qualification not found', 'VALIDATION');
    }
    if (src.learningPathId !== undefined && src.learningPathId !== null) {
      if (!isPositiveInteger(src.learningPathId)) return invalid('learningPathId must be a positive integer', 'VALIDATION');
      if (!(await this.learningPathRepository.findById(src.learningPathId))) return invalid('learning path not found', 'VALIDATION');
    }
    if (src.competencyId !== undefined && src.competencyId !== null) {
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId must be a positive integer', 'VALIDATION');
      if (!(await this.competencyRepository.findById(src.competencyId))) return invalid('competency not found', 'VALIDATION');
    }
    if (src.roleId !== undefined && !isPositiveInteger(src.roleId)) return invalid('roleId must be a positive integer', 'VALIDATION');
    if (src.issuingAuthority !== undefined && src.issuingAuthority !== null && !isNonEmptyString(src.issuingAuthority)) return invalid('issuingAuthority must be a non-empty string', 'VALIDATION');
    return null;
  }

  // Validate the classification / metadata fields shared by create and update. Returns invalid() or null.
  validateClassification(src) {
    if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
    if (src.renewalRequired !== undefined && !isBinaryFlag(src.renewalRequired)) return invalid('renewalRequired must be 0 or 1', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Register a certification. certificationCode must be unique among non-deleted certifications; any
  // supplied qualification / learning path / competency must exist.
  createCertification(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.certificationCode)) return invalid('certificationCode is required', 'VALIDATION');
      if (!isNonEmptyString(src.certificationName)) return invalid('certificationName is required', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const issueDate = pick(src, 'issueDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (issueDate !== null && expiryDate !== null && expiryDate < issueDate) return invalid('expiryDate must be on or after issueDate', 'VALIDATION');

      const existing = await this.repository.findByCertificationCode(src.certificationCode);
      if (existing) return invalid('certificationCode already exists', 'CONFLICT');

      const payload = {
        certificationCode: src.certificationCode,
        certificationName: src.certificationName,
        description: pick(src, 'description', null),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        roleId: pick(src, 'roleId', null),
        qualificationId: pick(src, 'qualificationId', null),
        learningPathId: pick(src, 'learningPathId', null),
        competencyId: pick(src, 'competencyId', null),
        issuingAuthority: pick(src, 'issuingAuthority', null),
        issueDate,
        expiryDate,
        renewalRequired: pick(src, 'renewalRequired', 0),
        status: pick(src, 'status', 'DRAFT'),
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const certification = await this.repository.create(payload);
      return { ok: true, certification: withMetadata(certification) };
    });
  }

  updateCertification(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('certification not found', 'NOT_FOUND');
      if (src.certificationName !== undefined && !isNonEmptyString(src.certificationName)) return invalid('certificationName must be a non-empty string', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const issueDate = pick(src, 'issueDate', current.issueDate);
      const expiryDate = pick(src, 'expiryDate', current.expiryDate);
      if (issueDate !== null && expiryDate !== null && expiryDate < issueDate) return invalid('expiryDate must be on or after issueDate', 'VALIDATION');

      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const certification = await this.repository.update(id, payload);
      return { ok: true, certification: withMetadata(certification) };
    });
  }

  getCertification(id) {
    return execute(async () => {
      const certification = await this.repository.findById(id);
      if (!certification) return invalid('certification not found', 'NOT_FOUND');
      return { ok: true, certification: withMetadata(certification) };
    });
  }

  listRoleCertifications(roleId) {
    return execute(async () => {
      const rows = await this.repository.findByRole(roleId);
      return { ok: true, certifications: rows.map((c) => withMetadata(c)) };
    });
  }

  listQualificationCertifications(qualificationId) {
    return execute(async () => {
      const rows = await this.repository.findByQualification(qualificationId);
      return { ok: true, certifications: rows.map((c) => withMetadata(c)) };
    });
  }

  listLearningPathCertifications(learningPathId) {
    return execute(async () => {
      const rows = await this.repository.findByLearningPath(learningPathId);
      return { ok: true, certifications: rows.map((c) => withMetadata(c)) };
    });
  }

  listCompetencyCertifications(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, certifications: rows.map((c) => withMetadata(c)) };
    });
  }

  activeCertifications() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, certifications: rows.map((c) => withMetadata(c)) };
    });
  }

  archiveCertification(id) {
    return execute(async () => {
      const certification = await this.repository.findById(id);
      if (!certification) return invalid('certification not found', 'NOT_FOUND');
      if (certification.archived) return invalid('certification already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, certification: withMetadata(updated) };
    });
  }

  deleteCertification(id) {
    return execute(async () => {
      const certification = await this.repository.findById(id);
      if (!certification) return invalid('certification not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreCertification(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('certification not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const certification = await this.repository.findById(id);
      return { ok: true, certification: withMetadata(certification) };
    });
  }
}

module.exports = EnterpriseCertificationService;
