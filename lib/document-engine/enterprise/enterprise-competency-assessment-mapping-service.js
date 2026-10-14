// WP-26 · Phase 10 — Enterprise Document Engine — Competency ↔ Assessment Mapping — Service.
//
// Business orchestration over an INJECTED mapping repository (reusing the certified BaseService) plus
// TWO READ-ONLY injected repositories — the WP-26 Phase 8 competency repository and the WP-26 Phase 9
// assessment repository — used only to validate that the mapped competency and assessment exist (both
// are never mutated). Enforces: competency/assessment existence, mapping uniqueness (one mapping per
// competency+assessment pair), mandatory validation, minimum-score / attempt validation, effective/
// expiry ordering validation, and lifecycle validation. NO controller/HTTP logic and NO SQL.
// Stateless, deterministic (dates stamped by the repository/SQLite; date ordering is a pure string
// compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByCompetency', 'findByAssessment', 'findMandatory', 'findExpired', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const MAPPING_TYPES = ['DIRECT', 'PREREQUISITE', 'EQUIVALENT', 'SUPPLEMENTARY'];
// Content fields settable via updateMapping (competencyId/assessmentId are the immutable identity).
const UPDATABLE_FIELDS = [
  'mappingType', 'required', 'minimumScore', 'minimumAttempts', 'mandatory', 'effectiveDate', 'expiryDate',
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
function isValidScore(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(mapping) {
  let metadata = null;
  try {
    metadata = mapping.metadataJson ? JSON.parse(mapping.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, mapping, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseCompetencyAssessmentMappingService extends BaseService {
  constructor(repository, competencyRepository, assessmentRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!competencyRepository || typeof competencyRepository.findById !== 'function') {
      throw new Error('EnterpriseCompetencyAssessmentMappingService requires an injected competency repository with findById()');
    }
    if (!assessmentRepository || typeof assessmentRepository.findById !== 'function') {
      throw new Error('EnterpriseCompetencyAssessmentMappingService requires an injected assessment repository with findById()');
    }
    this.competencyRepository = competencyRepository;
    this.assessmentRepository = assessmentRepository;
  }

  // Map a competency to an assessment. Both must exist; the pair must be unique among non-deleted rows.
  createMapping(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId is required', 'VALIDATION');
      if (!isPositiveInteger(src.assessmentId)) return invalid('assessmentId is required', 'VALIDATION');
      const competency = await this.competencyRepository.findById(src.competencyId);
      if (!competency) return invalid('competency not found', 'VALIDATION');
      const assessment = await this.assessmentRepository.findById(src.assessmentId);
      if (!assessment) return invalid('assessment not found', 'VALIDATION');

      const mappingType = pick(src, 'mappingType', 'DIRECT');
      if (!MAPPING_TYPES.includes(mappingType)) return invalid('invalid mappingType', 'VALIDATION');
      const required = pick(src, 'required', 1);
      if (!isBinaryFlag(required)) return invalid('required must be 0 or 1', 'VALIDATION');
      const mandatory = pick(src, 'mandatory', 0);
      if (!isBinaryFlag(mandatory)) return invalid('mandatory must be 0 or 1', 'VALIDATION');
      if (src.minimumScore !== undefined && !isValidScore(src.minimumScore)) return invalid('minimumScore must be an integer 0-100', 'VALIDATION');
      if (src.minimumAttempts !== undefined && !isPositiveInteger(src.minimumAttempts)) return invalid('minimumAttempts must be a positive integer', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const effectiveDate = pick(src, 'effectiveDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) return invalid('expiryDate must be on or after effectiveDate', 'VALIDATION');

      const existing = await this.repository.findByCompetency(competency.id);
      if (existing.some((m) => m.assessmentId === assessment.id)) return invalid('mapping already exists for this competency and assessment', 'CONFLICT');

      const payload = {
        competencyId: competency.id,
        assessmentId: assessment.id,
        mappingType,
        required,
        minimumScore: pick(src, 'minimumScore', null),
        minimumAttempts: pick(src, 'minimumAttempts', null),
        mandatory,
        effectiveDate,
        expiryDate,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const mapping = await this.repository.create(payload);
      return { ok: true, mapping: withMetadata(mapping) };
    });
  }

  updateMapping(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('mapping not found', 'NOT_FOUND');
      if (src.mappingType !== undefined && !MAPPING_TYPES.includes(src.mappingType)) return invalid('invalid mappingType', 'VALIDATION');
      if (src.required !== undefined && !isBinaryFlag(src.required)) return invalid('required must be 0 or 1', 'VALIDATION');
      if (src.mandatory !== undefined && !isBinaryFlag(src.mandatory)) return invalid('mandatory must be 0 or 1', 'VALIDATION');
      if (src.minimumScore !== undefined && !isValidScore(src.minimumScore)) return invalid('minimumScore must be an integer 0-100', 'VALIDATION');
      if (src.minimumAttempts !== undefined && !isPositiveInteger(src.minimumAttempts)) return invalid('minimumAttempts must be a positive integer', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const mapping = await this.repository.update(id, payload);
      return { ok: true, mapping: withMetadata(mapping) };
    });
  }

  getMapping(id) {
    return execute(async () => {
      const mapping = await this.repository.findById(id);
      if (!mapping) return invalid('mapping not found', 'NOT_FOUND');
      return { ok: true, mapping: withMetadata(mapping) };
    });
  }

  listCompetencyMappings(competencyId) {
    return execute(async () => {
      const mappings = await this.repository.findByCompetency(competencyId);
      return { ok: true, mappings: mappings.map((m) => withMetadata(m)) };
    });
  }

  listAssessmentMappings(assessmentId) {
    return execute(async () => {
      const mappings = await this.repository.findByAssessment(assessmentId);
      return { ok: true, mappings: mappings.map((m) => withMetadata(m)) };
    });
  }

  mandatoryMappings() {
    return execute(async () => {
      const mappings = await this.repository.findMandatory();
      return { ok: true, mappings: mappings.map((m) => withMetadata(m)) };
    });
  }

  expiredMappings() {
    return execute(async () => {
      const mappings = await this.repository.findExpired();
      return { ok: true, mappings: mappings.map((m) => withMetadata(m)) };
    });
  }

  // Active mappings (service-level query over the reused findActive).
  activeMappings() {
    return execute(async () => {
      const mappings = await this.repository.findActive();
      return { ok: true, mappings: mappings.map((m) => withMetadata(m)) };
    });
  }

  archiveMapping(id) {
    return execute(async () => {
      const mapping = await this.repository.findById(id);
      if (!mapping) return invalid('mapping not found', 'NOT_FOUND');
      if (mapping.archived) return invalid('mapping already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, mapping: withMetadata(updated) };
    });
  }

  deleteMapping(id) {
    return execute(async () => {
      const mapping = await this.repository.findById(id);
      if (!mapping) return invalid('mapping not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreMapping(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('mapping not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const mapping = await this.repository.findById(id);
      return { ok: true, mapping: withMetadata(mapping) };
    });
  }
}

module.exports = EnterpriseCompetencyAssessmentMappingService;
