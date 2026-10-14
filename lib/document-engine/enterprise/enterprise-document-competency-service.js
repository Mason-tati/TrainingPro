// WP-26 · Phase 8 — Enterprise Document Engine — Competency Management — Service.
//
// Business orchestration over an INJECTED competency repository (reusing the certified BaseService)
// plus a READ-ONLY injected WP-26 Phase 4 document-version repository (used only to validate the
// version exists — never mutated). Enforces: version validation, competency validation, mandatory /
// assessment-requirement / training-requirement validation, competency-lifecycle validation, and
// expiry calculation (expiryDate derived deterministically from effectiveDate + validationPeriodMonths
// when not supplied). NO controller/HTTP logic and NO SQL. Stateless, deterministic (no clock is
// read; timestamps are stamped by the repository/SQLite; expiry math is a pure function of inputs),
// never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findMandatory', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const COMPETENCY_LEVELS = ['AWARENESS', 'BASIC', 'INTERMEDIATE', 'ADVANCED', 'EXPERT'];
// Content fields settable via updateCompetency (version immutable).
const UPDATABLE_FIELDS = [
  'competencyId', 'competencyCode', 'competencyName', 'competencyLevel', 'requiredScore',
  'minimumAttempts', 'assessmentRequired', 'trainingRequired', 'mandatoryCompetency',
  'validationPeriodMonths', 'effectiveDate', 'expiryDate',
];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
function isBinaryFlag(value) {
  return value === 0 || value === 1;
}
function isValidScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
// Pure, deterministic expiry: parse a fixed YYYY-MM-DD, add months, format. Reads no clock.
function computeExpiry(effectiveDate, months) {
  const parsed = new Date(`${effectiveDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCMonth(parsed.getUTCMonth() + months);
  return parsed.toISOString().slice(0, 10);
}
function withMetadata(competency) {
  let metadata = null;
  try {
    metadata = competency.metadataJson ? JSON.parse(competency.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, competency, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentCompetencyService extends BaseService {
  constructor(repository, versionRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!versionRepository || typeof versionRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentCompetencyService requires an injected version repository with findById()');
    }
    this.versionRepository = versionRepository;
  }

  // Define a competency requirement for a version.
  createCompetency(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (src.documentVersionId === undefined || src.documentVersionId === null) return invalid('documentVersionId is required', 'VALIDATION');
      const version = await this.versionRepository.findById(src.documentVersionId);
      if (!version) return invalid('document version not found', 'VALIDATION');
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId is required', 'VALIDATION');
      if (!isNonEmptyString(src.competencyCode)) return invalid('competencyCode is required', 'VALIDATION');
      if (!isNonEmptyString(src.competencyName)) return invalid('competencyName is required', 'VALIDATION');

      const competencyLevel = pick(src, 'competencyLevel', 'BASIC');
      if (!COMPETENCY_LEVELS.includes(competencyLevel)) return invalid('invalid competencyLevel', 'VALIDATION');
      const mandatoryCompetency = pick(src, 'mandatoryCompetency', 0);
      if (!isBinaryFlag(mandatoryCompetency)) return invalid('mandatoryCompetency must be 0 or 1', 'VALIDATION');
      const assessmentRequired = pick(src, 'assessmentRequired', 0);
      if (!isBinaryFlag(assessmentRequired)) return invalid('assessmentRequired must be 0 or 1', 'VALIDATION');
      const trainingRequired = pick(src, 'trainingRequired', 0);
      if (!isBinaryFlag(trainingRequired)) return invalid('trainingRequired must be 0 or 1', 'VALIDATION');
      if (src.requiredScore !== undefined && !isValidScore(src.requiredScore)) return invalid('requiredScore must be an integer 0-100', 'VALIDATION');
      if (src.minimumAttempts !== undefined && !isNonNegativeInteger(src.minimumAttempts)) return invalid('minimumAttempts must be a non-negative integer', 'VALIDATION');
      if (src.validationPeriodMonths !== undefined && !isNonNegativeInteger(src.validationPeriodMonths)) return invalid('validationPeriodMonths must be a non-negative integer', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      const effectiveDate = pick(src, 'effectiveDate', null);
      const validationPeriodMonths = pick(src, 'validationPeriodMonths', null);
      let expiryDate = pick(src, 'expiryDate', null);
      if (expiryDate === null && effectiveDate !== null && validationPeriodMonths !== null) {
        expiryDate = computeExpiry(effectiveDate, validationPeriodMonths);
      }

      const payload = {
        documentVersionId: version.id,
        competencyId: src.competencyId,
        competencyCode: src.competencyCode,
        competencyName: src.competencyName,
        competencyLevel,
        requiredScore: pick(src, 'requiredScore', null),
        minimumAttempts: pick(src, 'minimumAttempts', null),
        assessmentRequired,
        trainingRequired,
        mandatoryCompetency,
        validationPeriodMonths,
        effectiveDate,
        expiryDate,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const competency = await this.repository.create(payload);
      return { ok: true, competency: withMetadata(competency) };
    });
  }

  updateCompetency(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('competency not found', 'NOT_FOUND');
      if (src.competencyLevel !== undefined && !COMPETENCY_LEVELS.includes(src.competencyLevel)) return invalid('invalid competencyLevel', 'VALIDATION');
      if (src.mandatoryCompetency !== undefined && !isBinaryFlag(src.mandatoryCompetency)) return invalid('mandatoryCompetency must be 0 or 1', 'VALIDATION');
      if (src.assessmentRequired !== undefined && !isBinaryFlag(src.assessmentRequired)) return invalid('assessmentRequired must be 0 or 1', 'VALIDATION');
      if (src.trainingRequired !== undefined && !isBinaryFlag(src.trainingRequired)) return invalid('trainingRequired must be 0 or 1', 'VALIDATION');
      if (src.requiredScore !== undefined && !isValidScore(src.requiredScore)) return invalid('requiredScore must be an integer 0-100', 'VALIDATION');
      if (src.minimumAttempts !== undefined && !isNonNegativeInteger(src.minimumAttempts)) return invalid('minimumAttempts must be a non-negative integer', 'VALIDATION');
      if (src.validationPeriodMonths !== undefined && !isNonNegativeInteger(src.validationPeriodMonths)) return invalid('validationPeriodMonths must be a non-negative integer', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const competency = await this.repository.update(id, payload);
      return { ok: true, competency: withMetadata(competency) };
    });
  }

  getCompetency(id) {
    return execute(async () => {
      const competency = await this.repository.findById(id);
      if (!competency) return invalid('competency not found', 'NOT_FOUND');
      return { ok: true, competency: withMetadata(competency) };
    });
  }

  listVersionCompetencies(documentVersionId) {
    return execute(async () => {
      const competencies = await this.repository.findByVersion(documentVersionId);
      return { ok: true, competencies: competencies.map((c) => withMetadata(c)) };
    });
  }

  mandatoryCompetencies() {
    return execute(async () => {
      const competencies = await this.repository.findMandatory();
      return { ok: true, competencies: competencies.map((c) => withMetadata(c)) };
    });
  }

  expiredCompetencies() {
    return execute(async () => {
      const competencies = await this.repository.findExpired();
      return { ok: true, competencies: competencies.map((c) => withMetadata(c)) };
    });
  }

  // Active competencies (service-level query over the reused findActive).
  activeCompetencies() {
    return execute(async () => {
      const competencies = await this.repository.findActive();
      return { ok: true, competencies: competencies.map((c) => withMetadata(c)) };
    });
  }

  archiveCompetency(id) {
    return execute(async () => {
      const competency = await this.repository.findById(id);
      if (!competency) return invalid('competency not found', 'NOT_FOUND');
      if (competency.archived) return invalid('competency already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, competency: withMetadata(updated) };
    });
  }

  deleteCompetency(id) {
    return execute(async () => {
      const competency = await this.repository.findById(id);
      if (!competency) return invalid('competency not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreCompetency(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('competency not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const competency = await this.repository.findById(id);
      return { ok: true, competency: withMetadata(competency) };
    });
  }
}

module.exports = EnterpriseDocumentCompetencyService;
