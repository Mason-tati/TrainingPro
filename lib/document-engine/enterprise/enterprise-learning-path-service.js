// WP-26 · Phase 15 — Enterprise Document Engine — Learning Path — Service.
//
// Business orchestration over an INJECTED learning-path repository (reusing the certified BaseService)
// plus FIVE READ-ONLY injected repositories — the WP-26 Phase 14 training-program repository, the Phase 7
// training-assignment repository, the Phase 8 competency repository, the Phase 12 employee competency
// profile repository, and the Phase 13 competency recertification repository. The training-program and
// competency repositories validate that a path's program / competency exist; the prerequisite reference
// is validated against this path repository itself (a path may depend on another path); the remaining
// three are held read-only for downstream integration and are never mutated. Enforces: path-code
// uniqueness, training-program / competency existence, role / sequence / prerequisite validation,
// mandatory & status validation, estimated-hours validation, effective/expiry ordering, and metadata
// validation. NO controller/HTTP logic and NO SQL. Stateless, deterministic (dates stamped by the
// repository/SQLite; ordering is a pure string compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByPathCode', 'findByRole', 'findByTrainingProgram', 'findByCompetency', 'findMandatory', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const STATUSES = ['DRAFT', 'ACTIVE', 'SUSPENDED', 'RETIRED'];
// Content fields settable via updateLearningPath (pathCode is the immutable business key).
const UPDATABLE_FIELDS = [
  'pathName', 'description', 'department', 'site', 'businessUnit', 'roleId', 'trainingProgramId',
  'competencyId', 'sequenceNumber', 'prerequisitePathId', 'estimatedHours', 'mandatory', 'status',
  'effectiveDate', 'expiryDate',
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
function withMetadata(path) {
  let metadata = null;
  try {
    metadata = path.metadataJson ? JSON.parse(path.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, path, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseLearningPathService extends BaseService {
  constructor(repository, trainingProgramRepository, trainingAssignmentRepository, competencyRepository, profileRepository, recertificationRepository) {
    super(repository, REPOSITORY_METHODS);
    const deps = [
      ['training program', trainingProgramRepository], ['training assignment', trainingAssignmentRepository],
      ['competency', competencyRepository], ['profile', profileRepository],
      ['recertification', recertificationRepository],
    ];
    for (const [name, repo] of deps) {
      if (!repo || typeof repo.findById !== 'function') {
        throw new Error(`EnterpriseLearningPathService requires an injected ${name} repository with findById()`);
      }
    }
    this.trainingProgramRepository = trainingProgramRepository;
    this.trainingAssignmentRepository = trainingAssignmentRepository;
    this.competencyRepository = competencyRepository;
    this.profileRepository = profileRepository;
    this.recertificationRepository = recertificationRepository;
  }

  // Validate the domain references (training program / competency existence), the role id, and the
  // prerequisite path (which must exist among learning paths). Returns invalid() or null.
  async validateReferences(src) {
    if (src.trainingProgramId !== undefined && src.trainingProgramId !== null) {
      if (!isPositiveInteger(src.trainingProgramId)) return invalid('trainingProgramId must be a positive integer', 'VALIDATION');
      if (!(await this.trainingProgramRepository.findById(src.trainingProgramId))) return invalid('training program not found', 'VALIDATION');
    }
    if (src.competencyId !== undefined && src.competencyId !== null) {
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId must be a positive integer', 'VALIDATION');
      if (!(await this.competencyRepository.findById(src.competencyId))) return invalid('competency not found', 'VALIDATION');
    }
    if (src.roleId !== undefined && !isPositiveInteger(src.roleId)) return invalid('roleId must be a positive integer', 'VALIDATION');
    if (src.prerequisitePathId !== undefined && src.prerequisitePathId !== null) {
      if (!isPositiveInteger(src.prerequisitePathId)) return invalid('prerequisitePathId must be a positive integer', 'VALIDATION');
      if (!(await this.repository.findById(src.prerequisitePathId))) return invalid('prerequisite path not found', 'VALIDATION');
    }
    return null;
  }

  // Validate the classification / numeric / metadata fields shared by create and update. Returns
  // invalid() or null.
  validateClassification(src) {
    if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
    if (src.mandatory !== undefined && !isBinaryFlag(src.mandatory)) return invalid('mandatory must be 0 or 1', 'VALIDATION');
    if (src.sequenceNumber !== undefined && !isPositiveInteger(src.sequenceNumber)) return invalid('sequenceNumber must be a positive integer', 'VALIDATION');
    if (src.estimatedHours !== undefined && !isNonNegativeNumber(src.estimatedHours)) return invalid('estimatedHours must be a non-negative number', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Register a learning path. pathCode must be unique among non-deleted paths; any supplied training
  // program / competency / prerequisite path must exist.
  createLearningPath(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isNonEmptyString(src.pathCode)) return invalid('pathCode is required', 'VALIDATION');
      if (!isNonEmptyString(src.pathName)) return invalid('pathName is required', 'VALIDATION');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const classError = this.validateClassification(src);
      if (classError) return classError;
      const effectiveDate = pick(src, 'effectiveDate', null);
      const expiryDate = pick(src, 'expiryDate', null);
      if (effectiveDate !== null && expiryDate !== null && expiryDate < effectiveDate) return invalid('expiryDate must be on or after effectiveDate', 'VALIDATION');

      const existing = await this.repository.findByPathCode(src.pathCode);
      if (existing) return invalid('pathCode already exists', 'CONFLICT');

      const payload = {
        pathCode: src.pathCode,
        pathName: src.pathName,
        description: pick(src, 'description', null),
        department: pick(src, 'department', null),
        site: pick(src, 'site', null),
        businessUnit: pick(src, 'businessUnit', null),
        roleId: pick(src, 'roleId', null),
        trainingProgramId: pick(src, 'trainingProgramId', null),
        competencyId: pick(src, 'competencyId', null),
        sequenceNumber: pick(src, 'sequenceNumber', null),
        prerequisitePathId: pick(src, 'prerequisitePathId', null),
        estimatedHours: pick(src, 'estimatedHours', null),
        mandatory: pick(src, 'mandatory', 0),
        status: pick(src, 'status', 'DRAFT'),
        effectiveDate,
        expiryDate,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const path = await this.repository.create(payload);
      return { ok: true, path: withMetadata(path) };
    });
  }

  updateLearningPath(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('learning path not found', 'NOT_FOUND');
      if (src.pathName !== undefined && !isNonEmptyString(src.pathName)) return invalid('pathName must be a non-empty string', 'VALIDATION');
      if (src.prerequisitePathId !== undefined && src.prerequisitePathId === id) return invalid('prerequisitePathId cannot reference the path itself', 'VALIDATION');
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
      const path = await this.repository.update(id, payload);
      return { ok: true, path: withMetadata(path) };
    });
  }

  getLearningPath(id) {
    return execute(async () => {
      const path = await this.repository.findById(id);
      if (!path) return invalid('learning path not found', 'NOT_FOUND');
      return { ok: true, path: withMetadata(path) };
    });
  }

  listRolePaths(roleId) {
    return execute(async () => {
      const rows = await this.repository.findByRole(roleId);
      return { ok: true, paths: rows.map((p) => withMetadata(p)) };
    });
  }

  listProgramPaths(trainingProgramId) {
    return execute(async () => {
      const rows = await this.repository.findByTrainingProgram(trainingProgramId);
      return { ok: true, paths: rows.map((p) => withMetadata(p)) };
    });
  }

  listCompetencyPaths(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, paths: rows.map((p) => withMetadata(p)) };
    });
  }

  mandatoryPaths() {
    return execute(async () => {
      const rows = await this.repository.findMandatory();
      return { ok: true, paths: rows.map((p) => withMetadata(p)) };
    });
  }

  activePaths() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, paths: rows.map((p) => withMetadata(p)) };
    });
  }

  archiveLearningPath(id) {
    return execute(async () => {
      const path = await this.repository.findById(id);
      if (!path) return invalid('learning path not found', 'NOT_FOUND');
      if (path.archived) return invalid('learning path already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, path: withMetadata(updated) };
    });
  }

  deleteLearningPath(id) {
    return execute(async () => {
      const path = await this.repository.findById(id);
      if (!path) return invalid('learning path not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreLearningPath(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('learning path not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const path = await this.repository.findById(id);
      return { ok: true, path: withMetadata(path) };
    });
  }
}

module.exports = EnterpriseLearningPathService;
