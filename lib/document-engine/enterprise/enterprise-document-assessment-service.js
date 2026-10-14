// WP-26 · Phase 9 — Enterprise Document Engine — Assessment Management — Service.
//
// Business orchestration over an INJECTED assessment repository (reusing the certified BaseService)
// plus a READ-ONLY injected WP-26 Phase 4 document-version repository (used only to validate the
// version exists — never mutated). Enforces: version validation, assessment validation, assessment-
// type validation, pass-mark / attempt / question-count validation, randomization validation, the
// publication lifecycle (DRAFT -> PUBLISHED with a readiness check), and expiry via the reused
// findExpired query. NO controller/HTTP logic and NO SQL. Stateless, deterministic (dates stamped by
// the repository/SQLite), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findActive', 'findExpired', 'findPublished', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const ASSESSMENT_TYPES = ['QUIZ', 'EXAM', 'SURVEY', 'PRACTICAL', 'CERTIFICATION'];
const ASSESSMENT_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED', 'ARCHIVED'];
// Content fields settable via updateAssessment (version immutable).
const UPDATABLE_FIELDS = [
  'assessmentId', 'assessmentCode', 'assessmentTitle', 'assessmentType', 'passMark', 'maximumAttempts',
  'timeLimitMinutes', 'questionCount', 'randomizeQuestions', 'randomizeAnswers', 'assessmentStatus',
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
function isValidMark(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}
function pick(src, key, fallback) {
  return src[key] === undefined ? fallback : src[key];
}
function invalid(error, code) {
  return { ok: false, error, code };
}
function withMetadata(assessment) {
  let metadata = null;
  try {
    metadata = assessment.metadataJson ? JSON.parse(assessment.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, assessment, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentAssessmentService extends BaseService {
  constructor(repository, versionRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!versionRepository || typeof versionRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentAssessmentService requires an injected version repository with findById()');
    }
    this.versionRepository = versionRepository;
  }

  // Define an assessment for a version (starts in DRAFT unless a valid status is supplied).
  createAssessment(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (src.documentVersionId === undefined || src.documentVersionId === null) return invalid('documentVersionId is required', 'VALIDATION');
      const version = await this.versionRepository.findById(src.documentVersionId);
      if (!version) return invalid('document version not found', 'VALIDATION');
      if (!isPositiveInteger(src.assessmentId)) return invalid('assessmentId is required', 'VALIDATION');
      if (!isNonEmptyString(src.assessmentCode)) return invalid('assessmentCode is required', 'VALIDATION');
      if (!isNonEmptyString(src.assessmentTitle)) return invalid('assessmentTitle is required', 'VALIDATION');

      const assessmentType = pick(src, 'assessmentType', 'QUIZ');
      if (!ASSESSMENT_TYPES.includes(assessmentType)) return invalid('invalid assessmentType', 'VALIDATION');
      const assessmentStatus = pick(src, 'assessmentStatus', 'DRAFT');
      if (!ASSESSMENT_STATUSES.includes(assessmentStatus)) return invalid('invalid assessmentStatus', 'VALIDATION');
      if (src.passMark !== undefined && !isValidMark(src.passMark)) return invalid('passMark must be an integer 0-100', 'VALIDATION');
      if (src.maximumAttempts !== undefined && !isPositiveInteger(src.maximumAttempts)) return invalid('maximumAttempts must be a positive integer', 'VALIDATION');
      if (src.timeLimitMinutes !== undefined && !isPositiveInteger(src.timeLimitMinutes)) return invalid('timeLimitMinutes must be a positive integer', 'VALIDATION');
      if (src.questionCount !== undefined && !isPositiveInteger(src.questionCount)) return invalid('questionCount must be a positive integer', 'VALIDATION');
      const randomizeQuestions = pick(src, 'randomizeQuestions', 0);
      if (!isBinaryFlag(randomizeQuestions)) return invalid('randomizeQuestions must be 0 or 1', 'VALIDATION');
      const randomizeAnswers = pick(src, 'randomizeAnswers', 0);
      if (!isBinaryFlag(randomizeAnswers)) return invalid('randomizeAnswers must be 0 or 1', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      const payload = {
        documentVersionId: version.id,
        assessmentId: src.assessmentId,
        assessmentCode: src.assessmentCode,
        assessmentTitle: src.assessmentTitle,
        assessmentType,
        passMark: pick(src, 'passMark', null),
        maximumAttempts: pick(src, 'maximumAttempts', null),
        timeLimitMinutes: pick(src, 'timeLimitMinutes', null),
        questionCount: pick(src, 'questionCount', null),
        randomizeQuestions,
        randomizeAnswers,
        assessmentStatus,
        effectiveDate: pick(src, 'effectiveDate', null),
        expiryDate: pick(src, 'expiryDate', null),
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const assessment = await this.repository.create(payload);
      return { ok: true, assessment: withMetadata(assessment) };
    });
  }

  updateAssessment(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('assessment not found', 'NOT_FOUND');
      if (src.assessmentType !== undefined && !ASSESSMENT_TYPES.includes(src.assessmentType)) return invalid('invalid assessmentType', 'VALIDATION');
      if (src.assessmentStatus !== undefined && !ASSESSMENT_STATUSES.includes(src.assessmentStatus)) return invalid('invalid assessmentStatus', 'VALIDATION');
      if (src.passMark !== undefined && !isValidMark(src.passMark)) return invalid('passMark must be an integer 0-100', 'VALIDATION');
      if (src.maximumAttempts !== undefined && !isPositiveInteger(src.maximumAttempts)) return invalid('maximumAttempts must be a positive integer', 'VALIDATION');
      if (src.timeLimitMinutes !== undefined && !isPositiveInteger(src.timeLimitMinutes)) return invalid('timeLimitMinutes must be a positive integer', 'VALIDATION');
      if (src.questionCount !== undefined && !isPositiveInteger(src.questionCount)) return invalid('questionCount must be a positive integer', 'VALIDATION');
      if (src.randomizeQuestions !== undefined && !isBinaryFlag(src.randomizeQuestions)) return invalid('randomizeQuestions must be 0 or 1', 'VALIDATION');
      if (src.randomizeAnswers !== undefined && !isBinaryFlag(src.randomizeAnswers)) return invalid('randomizeAnswers must be 0 or 1', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const assessment = await this.repository.update(id, payload);
      return { ok: true, assessment: withMetadata(assessment) };
    });
  }

  getAssessment(id) {
    return execute(async () => {
      const assessment = await this.repository.findById(id);
      if (!assessment) return invalid('assessment not found', 'NOT_FOUND');
      return { ok: true, assessment: withMetadata(assessment) };
    });
  }

  listVersionAssessments(documentVersionId) {
    return execute(async () => {
      const assessments = await this.repository.findByVersion(documentVersionId);
      return { ok: true, assessments: assessments.map((a) => withMetadata(a)) };
    });
  }

  publishedAssessments() {
    return execute(async () => {
      const assessments = await this.repository.findPublished();
      return { ok: true, assessments: assessments.map((a) => withMetadata(a)) };
    });
  }

  expiredAssessments() {
    return execute(async () => {
      const assessments = await this.repository.findExpired();
      return { ok: true, assessments: assessments.map((a) => withMetadata(a)) };
    });
  }

  // Active assessments (service-level query over the reused findActive).
  activeAssessments() {
    return execute(async () => {
      const assessments = await this.repository.findActive();
      return { ok: true, assessments: assessments.map((a) => withMetadata(a)) };
    });
  }

  // Publication lifecycle (service-level): a DRAFT assessment with a defined questionCount + passMark
  // can be published; an already-published (or unready) assessment cannot.
  publishAssessment(id) {
    return execute(async () => {
      const assessment = await this.repository.findById(id);
      if (!assessment) return invalid('assessment not found', 'NOT_FOUND');
      if (assessment.assessmentStatus === 'PUBLISHED') return invalid('assessment already published', 'VALIDATION');
      if (assessment.questionCount === null || assessment.passMark === null) return invalid('assessment must define questionCount and passMark before publishing', 'VALIDATION');
      const updated = await this.repository.update(id, { assessmentStatus: 'PUBLISHED' });
      return { ok: true, assessment: withMetadata(updated) };
    });
  }

  archiveAssessment(id) {
    return execute(async () => {
      const assessment = await this.repository.findById(id);
      if (!assessment) return invalid('assessment not found', 'NOT_FOUND');
      if (assessment.archived) return invalid('assessment already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, assessment: withMetadata(updated) };
    });
  }

  deleteAssessment(id) {
    return execute(async () => {
      const assessment = await this.repository.findById(id);
      if (!assessment) return invalid('assessment not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreAssessment(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('assessment not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const assessment = await this.repository.findById(id);
      return { ok: true, assessment: withMetadata(assessment) };
    });
  }
}

module.exports = EnterpriseDocumentAssessmentService;
