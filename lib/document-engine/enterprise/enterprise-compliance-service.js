// WP-26 · Phase 18 (FINAL) — Enterprise Document Engine — Compliance — Service.
//
// Business orchestration over an INJECTED compliance repository (reusing the certified BaseService) plus
// SEVEN READ-ONLY injected repositories — the WP-26 Phase 17 certification repository, the Phase 16
// qualification repository, the Phase 15 learning-path repository, the Phase 14 training-program
// repository, the Phase 8 competency repository, the Phase 12 employee competency profile repository, and
// the Phase 13 competency recertification repository. The certification / qualification / learning-path /
// competency repositories validate that a record's referenced items exist; the remaining three are held
// read-only for downstream integration and are never mutated. Enforces: employee validation, existence
// of the certification / qualification / learning path / competency references, compliance-status
// validation, renewal & risk validation, expiry ordering, a deterministic overdue calculation, and
// metadata validation. NO controller/HTTP logic and NO SQL. Stateless, deterministic (dates stamped by
// the repository/SQLite; ordering and overdue are pure functions of the record), never-throw,
// copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByRole', 'findByQualification', 'findByCertification', 'findByLearningPath', 'findByCompetency', 'findCompliant', 'findNonCompliant', 'findExpired', 'findOverdue', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const COMPLIANCE_STATUSES = ['COMPLIANT', 'NON_COMPLIANT', 'PENDING', 'EXPIRED', 'EXEMPT'];
const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
// A record is overdue for action when its compliance has lapsed.
const OVERDUE_STATUSES = ['NON_COMPLIANT', 'EXPIRED'];
// Content fields settable via updateCompliance (employeeId is the immutable anchor; overdue is derived).
const UPDATABLE_FIELDS = [
  'roleId', 'qualificationId', 'certificationId', 'learningPathId', 'competencyId', 'complianceStatus',
  'compliantDate', 'expiryDate', 'renewalRequired', 'riskLevel', 'department', 'site', 'businessUnit',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
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
// Deterministic overdue calculation: derived purely from the compliance status (no clock read).
function computeOverdue(complianceStatus) {
  return OVERDUE_STATUSES.includes(complianceStatus) ? 1 : 0;
}
function withMetadata(record) {
  let metadata = null;
  try {
    metadata = record.metadataJson ? JSON.parse(record.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, record, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseComplianceService extends BaseService {
  constructor(repository, certificationRepository, qualificationRepository, learningPathRepository, trainingProgramRepository, competencyRepository, profileRepository, recertificationRepository) {
    super(repository, REPOSITORY_METHODS);
    const deps = [
      ['certification', certificationRepository], ['qualification', qualificationRepository],
      ['learning path', learningPathRepository], ['training program', trainingProgramRepository],
      ['competency', competencyRepository], ['profile', profileRepository],
      ['recertification', recertificationRepository],
    ];
    for (const [name, repo] of deps) {
      if (!repo || typeof repo.findById !== 'function') {
        throw new Error(`EnterpriseComplianceService requires an injected ${name} repository with findById()`);
      }
    }
    this.certificationRepository = certificationRepository;
    this.qualificationRepository = qualificationRepository;
    this.learningPathRepository = learningPathRepository;
    this.trainingProgramRepository = trainingProgramRepository;
    this.competencyRepository = competencyRepository;
    this.profileRepository = profileRepository;
    this.recertificationRepository = recertificationRepository;
  }

  // Validate the domain references (certification / qualification / learning-path / competency existence)
  // and the role id. Returns an invalid() result, or null when all supplied values are OK.
  async validateReferences(src) {
    if (src.certificationId !== undefined && src.certificationId !== null) {
      if (!isPositiveInteger(src.certificationId)) return invalid('certificationId must be a positive integer', 'VALIDATION');
      if (!(await this.certificationRepository.findById(src.certificationId))) return invalid('certification not found', 'VALIDATION');
    }
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
    return null;
  }

  // Validate the classification / metadata fields shared by create and update. Returns invalid() or null.
  validateClassification(src) {
    if (src.complianceStatus !== undefined && !COMPLIANCE_STATUSES.includes(src.complianceStatus)) return invalid('invalid complianceStatus', 'VALIDATION');
    if (src.riskLevel !== undefined && !RISK_LEVELS.includes(src.riskLevel)) return invalid('invalid riskLevel', 'VALIDATION');
    if (src.renewalRequired !== undefined && !isBinaryFlag(src.renewalRequired)) return invalid('renewalRequired must be 0 or 1', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Record an employee's compliance standing against a credential. The employee is required; any supplied
  // certification / qualification / learning path / competency must exist. `overdue` is derived, not set.
  createCompliance(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isPositiveInteger(src.employeeId)) return invalid('employeeId is required', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const compliantDate = pick(src, 'compliantDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (compliantDate !== null && expiryDate !== null && expiryDate < compliantDate) return invalid('expiryDate must be on or after compliantDate', 'VALIDATION');

      const complianceStatus = pick(src, 'complianceStatus', 'PENDING');
      const payload = {
        employeeId: src.employeeId,
        roleId: pick(src, 'roleId', null),
        qualificationId: pick(src, 'qualificationId', null),
        certificationId: pick(src, 'certificationId', null),
        learningPathId: pick(src, 'learningPathId', null),
        competencyId: pick(src, 'competencyId', null),
        complianceStatus,
        compliantDate,
        expiryDate,
        renewalRequired: pick(src, 'renewalRequired', 0),
        overdue: computeOverdue(complianceStatus),
        riskLevel: pick(src, 'riskLevel', 'LOW'),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const record = await this.repository.create(payload);
      return { ok: true, compliance: withMetadata(record) };
    });
  }

  updateCompliance(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('compliance record not found', 'NOT_FOUND');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const compliantDate = pick(src, 'compliantDate', current.compliantDate);
      const expiryDate = pick(src, 'expiryDate', current.expiryDate);
      if (compliantDate !== null && expiryDate !== null && expiryDate < compliantDate) return invalid('expiryDate must be on or after compliantDate', 'VALIDATION');

      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      // Recompute the derived overdue flag from the effective compliance status.
      const effectiveStatus = src.complianceStatus !== undefined ? src.complianceStatus : current.complianceStatus;
      payload.overdue = computeOverdue(effectiveStatus);
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const record = await this.repository.update(id, payload);
      return { ok: true, compliance: withMetadata(record) };
    });
  }

  getCompliance(id) {
    return execute(async () => {
      const record = await this.repository.findById(id);
      if (!record) return invalid('compliance record not found', 'NOT_FOUND');
      return { ok: true, compliance: withMetadata(record) };
    });
  }

  listEmployeeCompliance(employeeId) {
    return execute(async () => {
      const rows = await this.repository.findByEmployee(employeeId);
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  listRoleCompliance(roleId) {
    return execute(async () => {
      const rows = await this.repository.findByRole(roleId);
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  listQualificationCompliance(qualificationId) {
    return execute(async () => {
      const rows = await this.repository.findByQualification(qualificationId);
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  listCertificationCompliance(certificationId) {
    return execute(async () => {
      const rows = await this.repository.findByCertification(certificationId);
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  listLearningPathCompliance(learningPathId) {
    return execute(async () => {
      const rows = await this.repository.findByLearningPath(learningPathId);
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  listCompetencyCompliance(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  compliantRecords() {
    return execute(async () => {
      const rows = await this.repository.findCompliant();
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  nonCompliantRecords() {
    return execute(async () => {
      const rows = await this.repository.findNonCompliant();
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  expiredRecords() {
    return execute(async () => {
      const rows = await this.repository.findExpired();
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  overdueRecords() {
    return execute(async () => {
      const rows = await this.repository.findOverdue();
      return { ok: true, compliance: rows.map((r) => withMetadata(r)) };
    });
  }

  archiveCompliance(id) {
    return execute(async () => {
      const record = await this.repository.findById(id);
      if (!record) return invalid('compliance record not found', 'NOT_FOUND');
      if (record.archived) return invalid('compliance record already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, compliance: withMetadata(updated) };
    });
  }

  deleteCompliance(id) {
    return execute(async () => {
      const record = await this.repository.findById(id);
      if (!record) return invalid('compliance record not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreCompliance(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('compliance record not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const record = await this.repository.findById(id);
      return { ok: true, compliance: withMetadata(record) };
    });
  }
}

module.exports = EnterpriseComplianceService;
