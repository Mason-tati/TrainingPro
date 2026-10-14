// WP-26 · Phase 13 — Enterprise Document Engine — Competency Recertification — Service.
//
// Business orchestration over an INJECTED recertification repository (reusing the certified BaseService)
// plus FIVE READ-ONLY injected repositories — the WP-26 Phase 12 employee competency profile repository,
// the Phase 8 competency repository, the Phase 9 assessment repository, the Phase 10 mapping repository,
// and the Phase 11 evidence repository — used only to validate that the referenced profile / competency /
// assessment / mapping / evidence exist (none is ever mutated). Enforces: profile & competency existence,
// existence of the optional evidence/assessment/mapping references, recertification-type / status /
// result validation, due-date presence, scheduling consistency (SCHEDULED needs a scheduledDate),
// completion consistency (COMPLETED needs a completedDate + result; a result implies COMPLETED; a
// completedDate is on or after the scheduledDate), and lifecycle validation. NO controller/HTTP logic and
// NO SQL. Stateless, deterministic (dates stamped by the repository/SQLite; ordering is a pure string
// compare), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByEmployee', 'findByCompetency', 'findDue', 'findScheduled', 'findCompleted', 'findOverdue', 'findActive', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const RECERT_TYPES = ['PERIODIC', 'REMEDIAL', 'REGULATORY', 'ROLE_CHANGE', 'AD_HOC'];
const STATUSES = ['PENDING', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED'];
const RESULTS = ['PASS', 'FAIL', 'WAIVED'];
// Content fields settable via updateRecertification (the profile/employee/competency identity is immutable;
// completedDate is handled by the repository boolean sentinel).
const UPDATABLE_FIELDS = [
  'currentEvidenceId', 'currentAssessmentId', 'currentMappingId', 'recertificationType', 'dueDate',
  'scheduledDate', 'status', 'result', 'assignedTrainerId', 'assignedAssessorId', 'comments',
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
function isComparableDate(value) {
  return typeof value === 'string' && value.length > 0;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(recert) {
  let metadata = null;
  try {
    metadata = recert.metadataJson ? JSON.parse(recert.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, recert, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseCompetencyRecertificationService extends BaseService {
  constructor(repository, profileRepository, competencyRepository, assessmentRepository, mappingRepository, evidenceRepository) {
    super(repository, REPOSITORY_METHODS);
    const deps = [
      ['profile', profileRepository], ['competency', competencyRepository], ['assessment', assessmentRepository],
      ['mapping', mappingRepository], ['evidence', evidenceRepository],
    ];
    for (const [name, repo] of deps) {
      if (!repo || typeof repo.findById !== 'function') {
        throw new Error(`EnterpriseCompetencyRecertificationService requires an injected ${name} repository with findById()`);
      }
    }
    this.profileRepository = profileRepository;
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

  // Validate the enum + assignee fields supplied in a patch/input. Returns invalid() or null.
  validateEnums(src) {
    if (src.recertificationType !== undefined && !RECERT_TYPES.includes(src.recertificationType)) return invalid('invalid recertificationType', 'VALIDATION');
    if (src.status !== undefined && !STATUSES.includes(src.status)) return invalid('invalid status', 'VALIDATION');
    if (src.result !== undefined && !RESULTS.includes(src.result)) return invalid('invalid result', 'VALIDATION');
    if (src.assignedTrainerId !== undefined && !isPositiveInteger(src.assignedTrainerId)) return invalid('assignedTrainerId must be a positive integer', 'VALIDATION');
    if (src.assignedAssessorId !== undefined && !isPositiveInteger(src.assignedAssessorId)) return invalid('assignedAssessorId must be a positive integer', 'VALIDATION');
    if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
    return null;
  }

  // Validate the scheduling/completion workflow over the effective status/result/dates. Returns invalid()
  // or null. A boolean `completedDate` sentinel counts as "present" but is not ordering-compared.
  validateWorkflow(status, result, scheduledDate, completedDate) {
    if (status === 'SCHEDULED' && !scheduledDate) return invalid('scheduledDate is required when status is SCHEDULED', 'VALIDATION');
    if (status === 'COMPLETED') {
      if (!completedDate) return invalid('completedDate is required when status is COMPLETED', 'VALIDATION');
      if (!result) return invalid('result is required when status is COMPLETED', 'VALIDATION');
    }
    if (result && status !== 'COMPLETED') return invalid('result requires status COMPLETED', 'VALIDATION');
    if (isComparableDate(completedDate) && isComparableDate(scheduledDate) && completedDate < scheduledDate) {
      return invalid('completedDate must be on or after scheduledDate', 'VALIDATION');
    }
    return null;
  }

  // Open a recertification for an employee's competency profile. The profile and competency must exist;
  // any supplied current reference must exist; the workflow fields must be internally consistent.
  createRecertification(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (!isPositiveInteger(src.employeeProfileId)) return invalid('employeeProfileId is required', 'VALIDATION');
      if (!isPositiveInteger(src.competencyId)) return invalid('competencyId is required', 'VALIDATION');
      const profile = await this.profileRepository.findById(src.employeeProfileId);
      if (!profile) return invalid('employee competency profile not found', 'VALIDATION');
      const competency = await this.competencyRepository.findById(src.competencyId);
      if (!competency) return invalid('competency not found', 'VALIDATION');

      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const enumError = this.validateEnums(src);
      if (enumError) return enumError;
      if (!isNonEmptyString(src.dueDate)) return invalid('dueDate is required', 'VALIDATION');
      if (!isPositiveInteger(src.employeeId)) return invalid('employeeId is required', 'VALIDATION');

      const status = pick(src, 'status', 'PENDING');
      const result = pick(src, 'result', null);
      const scheduledDate = pick(src, 'scheduledDate', null);
      const completedDate = pick(src, 'completedDate', null);
      const workflowError = this.validateWorkflow(status, result, scheduledDate, completedDate);
      if (workflowError) return workflowError;

      const payload = {
        employeeProfileId: src.employeeProfileId,
        employeeId: src.employeeId,
        competencyId: competency.id,
        currentEvidenceId: pick(src, 'currentEvidenceId', null),
        currentAssessmentId: pick(src, 'currentAssessmentId', null),
        currentMappingId: pick(src, 'currentMappingId', null),
        recertificationType: pick(src, 'recertificationType', 'PERIODIC'),
        dueDate: src.dueDate,
        scheduledDate,
        completedDate,
        status,
        result,
        assignedTrainerId: pick(src, 'assignedTrainerId', null),
        assignedAssessorId: pick(src, 'assignedAssessorId', null),
        comments: pick(src, 'comments', null),
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const recert = await this.repository.create(payload);
      return { ok: true, recertification: withMetadata(recert) };
    });
  }

  updateRecertification(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('recertification not found', 'NOT_FOUND');
      const refError = await this.validateReferences(src);
      if (refError) return refError;
      const enumError = this.validateEnums(src);
      if (enumError) return enumError;
      if (src.dueDate !== undefined && !isNonEmptyString(src.dueDate)) return invalid('dueDate must be a non-empty string', 'VALIDATION');

      const status = pick(src, 'status', current.status);
      const result = src.result !== undefined ? src.result : current.result;
      const scheduledDate = src.scheduledDate !== undefined ? src.scheduledDate : current.scheduledDate;
      const completedDate = src.completedDate !== undefined ? src.completedDate : current.completedDate;
      const workflowError = this.validateWorkflow(status, result, scheduledDate, completedDate);
      if (workflowError) return workflowError;

      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.completedDate !== undefined) payload.completedDate = src.completedDate;
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const recert = await this.repository.update(id, payload);
      return { ok: true, recertification: withMetadata(recert) };
    });
  }

  getRecertification(id) {
    return execute(async () => {
      const recert = await this.repository.findById(id);
      if (!recert) return invalid('recertification not found', 'NOT_FOUND');
      return { ok: true, recertification: withMetadata(recert) };
    });
  }

  listEmployeeRecertifications(employeeId) {
    return execute(async () => {
      const rows = await this.repository.findByEmployee(employeeId);
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  listCompetencyRecertifications(competencyId) {
    return execute(async () => {
      const rows = await this.repository.findByCompetency(competencyId);
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  dueRecertifications() {
    return execute(async () => {
      const rows = await this.repository.findDue();
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  scheduledRecertifications() {
    return execute(async () => {
      const rows = await this.repository.findScheduled();
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  completedRecertifications() {
    return execute(async () => {
      const rows = await this.repository.findCompleted();
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  overdueRecertifications() {
    return execute(async () => {
      const rows = await this.repository.findOverdue();
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  // Active recertifications (service-level query over the reused findActive).
  activeRecertifications() {
    return execute(async () => {
      const rows = await this.repository.findActive();
      return { ok: true, recertifications: rows.map((r) => withMetadata(r)) };
    });
  }

  archiveRecertification(id) {
    return execute(async () => {
      const recert = await this.repository.findById(id);
      if (!recert) return invalid('recertification not found', 'NOT_FOUND');
      if (recert.archived) return invalid('recertification already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, recertification: withMetadata(updated) };
    });
  }

  deleteRecertification(id) {
    return execute(async () => {
      const recert = await this.repository.findById(id);
      if (!recert) return invalid('recertification not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreRecertification(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('recertification not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const recert = await this.repository.findById(id);
      return { ok: true, recertification: withMetadata(recert) };
    });
  }
}

module.exports = EnterpriseCompetencyRecertificationService;
