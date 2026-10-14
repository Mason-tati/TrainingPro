// WP-26 · Phase 12 — Enterprise Document Engine — Employee Competency Profile — Service.
//
// Business orchestration over an INJECTED profile repository (reusing the certified BaseService) plus
// FOUR READ-ONLY injected repositories — the WP-26 Phase 8 competency repository, the Phase 9 assessment
// repository, the Phase 10 competency↔assessment mapping repository, and the Phase 11 competency
// evidence repository — used only to validate that the referenced competency / assessment / mapping /
// evidence exist (none is ever mutated). Enforces: employee/competency validation, existence of the
// current assessment/mapping/evidence references, compliance-status validation, risk-level validation,
// expiry ordering, review-date ordering, and one profile per employee×competency. NO controller/HTTP
// logic and NO SQL. Stateless, deterministic (dates stamped by the repository/SQLite; date ordering is a
// pure string compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findCompliant', 'findNonCompliant', 'findExpiring', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'ACHIEVED', 'LAPSED'];
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const COMPLIANCE_STATUSES = ['COMPLIANT', 'NON_COMPLIANT', 'PENDING', 'EXEMPT'];
const DEFAULT_EXPIRING_DAYS = 30;
// Content fields settable via updateProfile (employeeId/competencyId are the immutable identity).
const UPDATABLE_FIELDS = [
  'currentEvidenceId', 'currentAssessmentId', 'currentMappingId', 'status', 'achievedDate', 'expiryDate',
  'lastVerifiedDate', 'nextReviewDate', 'riskLevel', 'complianceStatus',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(profile) {
  let metadata = null;
  try {
    metadata = profile.metadataJson ? JSON.parse(profile.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, profile, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseEmployeeCompetencyProfileService extends BaseService {
  constructor(repository, competencyRepository, assessmentRepository, mappingRepository, evidenceRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!competencyRepository || typeof competencyRepository.findById !== 'function') {
      throw new Error('EnterpriseEmployeeCompetencyProfileService requires an injected competency repository with findById()');
    }
    if (!assessmentRepository || typeof assessmentRepository.findById !== 'function') {
      throw new Error('EnterpriseEmployeeCompetencyProfileService requires an injected assessment repository with findById()');
    }
    if (!mappingRepository || typeof mappingRepository.findById !== 'function') {
      throw new Error('EnterpriseEmployeeCompetencyProfileService requires an injected mapping repository with findById()');
    }
    if (!evidenceRepository || typeof evidenceRepository.findById !== 'function') {
      throw new Error('EnterpriseEmployeeCompetencyProfileService requires an injected evidence repository with findById()');
    }
    this.competencyRepository = competencyRepository;
    this.assessmentRepository = assessmentRepository;
    this.mappingRepository = mappingRepository;
    this.evidenceRepository = evidenceRepository;
  }

  // Validate the optional "current" references: each, when supplied, must be a positive integer that
  // resolves to an existing row in its domain. Returns an invalid() result, or null when all are OK.
  async validateReferences(src) {
    if (src.currentAssessmentId !== undefined) {
      if (!isPositiveInteger(src.currentAssessmentId)) return invalid('currentAssessmentId must be a positive integer', 'VALIDATION');
      if (!(await this.assessmentRepository.findById(src.currentAssessmentId))) return invalid('assessment not found', 'VALIDATION');
    }
    if (src.currentMappingId !== undefined) {
      if (!isPositiveInteger(src.currentMappingId)) return invalid('currentMappingId must be a positive integer', 'VALIDATION');
      if (!(await this.mappingRepository.findById(src.currentMappingId))) return invalid('mapping not found', 'VALIDATION');
    }
    if (src.currentEvidenceId !== undefined) {
      if (!isPositiveInteger(src.currentEvidenceId)) return invalid('currentEvidenceId must be a positive integer', 'VALIDATION');
      if (!(await this.evidenceRepository.findById(src.currentEvidenceId))) return invalid('evidence not found', 'VALIDATION');
    }
    return null;
  }

  // Validate the classification/date fields shared by create and update. Returns invalid() or null.
  validateClassification(src) {
    if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
    if (src.riskLevel !== undefined && !RISK_LEVELS.includes(src.riskLevel)) return invalid('invalid riskLevel', 'VALIDATION');
    if (src.complianceStatus !== undefined && !COMPLIANCE_STATUSES.includes(src.complianceStatus)) return invalid('invalid complianceStatus', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Create the profile for an employee×competency. The competency must exist; any supplied current
  // reference must exist; the pair must be unique among non-deleted rows.
  createProfile(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isPositiveInteger(src.employeeId)) return invalid('employeeId is required', 'VALIDATION');
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId is required', 'VALIDATION');
      const competency = await this.competencyRepository.findById(src.competencyId);
      if (!competency) return invalid('competency not found', 'VALIDATION');

      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;

      const achievedDate = pick(src, 'achievedDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (achievedDate !== null && expiryDate !== null && expiryDate < achievedDate) return invalid('expiryDate must be on or after achievedDate', 'VALIDATION');
      const nextReviewDate = pick(src, 'nextReviewDate', null);
      if (achievedDate !== null && nextReviewDate !== null && nextReviewDate < achievedDate) return invalid('nextReviewDate must be on or after achievedDate', 'VALIDATION');

      const existing = await this.repository.findByEmployee(src.employeeId);
      if (existing.some((p) => p.competencyId === competency.id)) return invalid('profile already exists for this employee and competency', 'CONFLICT');

      const payload = {
        employeeId: src.employeeId,
        competencyId: competency.id,
        currentEvidenceId: pick(src, 'currentEvidenceId', null),
        currentAssessmentId: pick(src, 'currentAssessmentId', null),
        currentMappingId: pick(src, 'currentMappingId', null),
        status: pick(src, 'status', 'NOT_STARTED'),
        achievedDate,
        expiryDate,
        lastVerifiedDate: pick(src, 'lastVerifiedDate', null),
        nextReviewDate,
        riskLevel: pick(src, 'riskLevel', 'LOW'),
        complianceStatus: pick(src, 'complianceStatus', 'PENDING'),
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const profile = await this.repository.create(payload);
      return { ok: true, profile: withMetadata(profile) };
    });
  }

  updateProfile(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('profile not found', 'NOT_FOUND');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;

      const achievedDate = pick(src, 'achievedDate', current.achievedDate);
      const expiryDate = pick(src, 'expiryDate', current.expiryDate);
      if (achievedDate !== null && expiryDate !== null && expiryDate < achievedDate) return invalid('expiryDate must be on or after achievedDate', 'VALIDATION');
      const nextReviewDate = pick(src, 'nextReviewDate', current.nextReviewDate);
      if (achievedDate !== null && nextReviewDate !== null && nextReviewDate < achievedDate) return invalid('nextReviewDate must be on or after achievedDate', 'VALIDATION');

      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const profile = await this.repository.update(id, payload);
      return { ok: true, profile: withMetadata(profile) };
    });
  }

  getProfile(id) {
    return execute(async () => {
      const profile = await this.repository.findById(id);
      if (!profile) return invalid('profile not found', 'NOT_FOUND');
      return { ok: true, profile: withMetadata(profile) };
    });
  }

  listEmployeeProfiles(employeeId) {
    return execute(async () => {
      const rows = await this.repository.findByEmployee(employeeId);
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  listCompetencyProfiles(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  compliantProfiles() {
    return execute(async () => {
      const rows = await this.repository.findCompliant();
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  nonCompliantProfiles() {
    return execute(async () => {
      const rows = await this.repository.findNonCompliant();
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  expiringProfiles(withinDays) {
    return execute(async () => {
      const days = isPositiveInteger(withinDays) ? withinDays : DEFAULT_EXPIRING_DAYS;
      const rows = await this.repository.findExpiring(days);
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  expiredProfiles() {
    return execute(async () => {
      const rows = await this.repository.findExpired();
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  // Active profiles (service-level query over the reused findActive).
  activeProfiles() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, profiles: rows.map((p) => withMetadata(p)) };
    });
  }

  archiveProfile(id) {
    return execute(async () => {
      const profile = await this.repository.findById(id);
      if (!profile) return invalid('profile not found', 'NOT_FOUND');
      if (profile.archived) return invalid('profile already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, profile: withMetadata(updated) };
    });
  }

  deleteProfile(id) {
    return execute(async () => {
      const profile = await this.repository.findById(id);
      if (!profile) return invalid('profile not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreProfile(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('profile not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const profile = await this.repository.findById(id);
      return { ok: true, profile: withMetadata(profile) };
    });
  }
}

module.exports = EnterpriseEmployeeCompetencyProfileService;
