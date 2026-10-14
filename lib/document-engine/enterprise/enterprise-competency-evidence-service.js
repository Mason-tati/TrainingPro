// WP-26 · Phase 11 — Enterprise Document Engine — Competency Evidence — Service.
//
// Business orchestration over an INJECTED evidence repository (reusing the certified BaseService) plus
// THREE READ-ONLY injected repositories — the WP-26 Phase 8 competency repository, the WP-26 Phase 9
// assessment repository, and the WP-26 Phase 10 competency↔assessment mapping repository — used only to
// validate that the referenced competency, assessment, and mapping exist (none is ever mutated).
// Enforces: competency/assessment/mapping existence, employee validation, evidence validation (type,
// title), a verification workflow (PENDING → VERIFIED/REJECTED with verifier attribution and a stamped
// verification instant), effective/expiry ordering, and lifecycle validation. NO controller/HTTP logic
// and NO SQL. Stateless, deterministic (dates stamped by the repository/SQLite; date ordering is a pure
// string compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findByAssessment', 'findPendingVerification', 'findVerified', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const EVIDENCE_TYPES = ['CERTIFICATE', 'ASSESSMENT_RESULT', 'OBSERVATION', 'DOCUMENT', 'TRAINING_RECORD', 'OTHER'];
const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'];
// Content fields settable via updateEvidence (the FK identity is immutable; verification is handled separately).
const UPDATABLE_FIELDS = [
  'evidenceType', 'evidenceReference', 'evidenceTitle', 'evidenceDescription', 'effectiveDate', 'expiryDate',
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
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(evidence) {
  let metadata = null;
  try {
    metadata = evidence.metadataJson ? JSON.parse(evidence.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, evidence, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseCompetencyEvidenceService extends BaseService {
  constructor(repository, competencyRepository, assessmentRepository, mappingRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!competencyRepository || typeof competencyRepository.findById !== 'function') {
      throw new Error('EnterpriseCompetencyEvidenceService requires an injected competency repository with findById()');
    }
    if (!assessmentRepository || typeof assessmentRepository.findById !== 'function') {
      throw new Error('EnterpriseCompetencyEvidenceService requires an injected assessment repository with findById()');
    }
    if (!mappingRepository || typeof mappingRepository.findById !== 'function') {
      throw new Error('EnterpriseCompetencyEvidenceService requires an injected mapping repository with findById()');
    }
    this.competencyRepository = competencyRepository;
    this.assessmentRepository = assessmentRepository;
    this.mappingRepository = mappingRepository;
  }

  // Record evidence that an employee satisfies a competency via a specific assessment mapping.
  // The competency, assessment, and mapping must all exist.
  createEvidence(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId is required', 'VALIDATION');
      if (!isPositiveInteger(src.assessmentId)) return invalid('assessmentId is required', 'VALIDATION');
      if (!isPositiveInteger(src.mappingId)) return invalid('mappingId is required', 'VALIDATION');
      if (!isPositiveInteger(src.employeeId)) return invalid('employeeId is required', 'VALIDATION');
      const competency = await this.competencyRepository.findById(src.competencyId);
      if (!competency) return invalid('competency not found', 'VALIDATION');
      const assessment = await this.assessmentRepository.findById(src.assessmentId);
      if (!assessment) return invalid('assessment not found', 'VALIDATION');
      const mapping = await this.mappingRepository.findById(src.mappingId);
      if (!mapping) return invalid('mapping not found', 'VALIDATION');

      const evidenceType = pick(src, 'evidenceType', 'OTHER');
      if (!EVIDENCE_TYPES.includes(evidenceType)) return invalid('invalid evidenceType', 'VALIDATION');
      if (!isNonEmptyString(src.evidenceTitle)) return invalid('evidenceTitle is required', 'VALIDATION');
      if (src.evidenceReference !== undefined && !isNonEmptyString(src.evidenceReference)) return invalid('evidenceReference must be a non-empty string', 'VALIDATION');
      const verificationStatus = pick(src, 'verificationStatus', 'PENDING');
      if (!VERIFICATION_STATUSES.includes(verificationStatus)) return invalid('invalid verificationStatus', 'VALIDATION');
      if (src.verifiedBy !== undefined && !isPositiveInteger(src.verifiedBy)) return invalid('verifiedBy must be a positive integer', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const effectiveDate = pick(src, 'effectiveDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) return invalid('expiryDate must be on or after effectiveDate', 'VALIDATION');

      const payload = {
        competencyId: competency.id,
        assessmentId: assessment.id,
        mappingId: mapping.id,
        employeeId: src.employeeId,
        evidenceType,
        evidenceReference: pick(src, 'evidenceReference', null),
        evidenceTitle: src.evidenceTitle,
        evidenceDescription: pick(src, 'evidenceDescription', null),
        verifiedBy: pick(src, 'verifiedBy', null),
        verificationStatus,
        effectiveDate,
        expiryDate,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const evidence = await this.repository.create(payload);
      return { ok: true, evidence: withMetadata(evidence) };
    });
  }

  updateEvidence(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('evidence not found', 'NOT_FOUND');
      if (src.evidenceType !== undefined && !EVIDENCE_TYPES.includes(src.evidenceType)) return invalid('invalid evidenceType', 'VALIDATION');
      if (src.evidenceTitle !== undefined && !isNonEmptyString(src.evidenceTitle)) return invalid('evidenceTitle must be a non-empty string', 'VALIDATION');
      if (src.evidenceReference !== undefined && !isNonEmptyString(src.evidenceReference)) return invalid('evidenceReference must be a non-empty string', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const evidence = await this.repository.update(id, payload);
      return { ok: true, evidence: withMetadata(evidence) };
    });
  }

  // Verification workflow: a verifier (verifiedBy) transitions the evidence to VERIFIED or REJECTED,
  // stamping the verification instant via the repository boolean sentinel.
  verifyEvidence(id, input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('evidence not found', 'NOT_FOUND');
      const status = pick(src, 'verificationStatus', 'VERIFIED');
      if (status !== 'VERIFIED' && status !== 'REJECTED') return invalid('verificationStatus must be VERIFIED or REJECTED', 'VALIDATION');
      if (!isPositiveInteger(src.verifiedBy)) return invalid('verifiedBy is required', 'VALIDATION');
      await this.repository.update(id, { verificationStatus: status, verifiedBy: src.verifiedBy, verifiedDate: true });
      const evidence = await this.repository.findById(id);
      return { ok: true, evidence: withMetadata(evidence) };
    });
  }

  getEvidence(id) {
    return execute(async () => {
      const evidence = await this.repository.findById(id);
      if (!evidence) return invalid('evidence not found', 'NOT_FOUND');
      return { ok: true, evidence: withMetadata(evidence) };
    });
  }

  listEmployeeEvidence(employeeId) {
    return execute(async () => {
      const rows = await this.repository.findByEmployee(employeeId);
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  listCompetencyEvidence(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  listAssessmentEvidence(assessmentId) {
    return execute(async () => {
      const rows = await this.repository.findByAssessment(assessmentId);
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  pendingEvidence() {
    return execute(async () => {
      const rows = await this.repository.findPendingVerification();
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  verifiedEvidence() {
    return execute(async () => {
      const rows = await this.repository.findVerified();
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  expiredEvidence() {
    return execute(async () => {
      const rows = await this.repository.findExpired();
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  // Active evidence (service-level query over the reused findActive).
  activeEvidence() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, evidence: rows.map((e) => withMetadata(e)) };
    });
  }

  archiveEvidence(id) {
    return execute(async () => {
      const evidence = await this.repository.findById(id);
      if (!evidence) return invalid('evidence not found', 'NOT_FOUND');
      if (evidence.archived) return invalid('evidence already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, evidence: withMetadata(updated) };
    });
  }

  deleteEvidence(id) {
    return execute(async () => {
      const evidence = await this.repository.findById(id);
      if (!evidence) return invalid('evidence not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreEvidence(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('evidence not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const evidence = await this.repository.findById(id);
      return { ok: true, evidence: withMetadata(evidence) };
    });
  }
}

module.exports = EnterpriseCompetencyEvidenceService;
