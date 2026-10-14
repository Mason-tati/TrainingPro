// WP-26 · Phase 7 — Enterprise Document Engine — Training Assignment — Service.
//
// Business orchestration over an INJECTED training repository (reusing the certified BaseService) plus
// a READ-ONLY injected WP-26 Phase 4 document-version repository (used only to validate the trained
// version exists — never mutated). Enforces: version existence, training assignment (recipient)
// validation, mandatory-training validation, assessment validation, competency-linkage validation,
// completion validation, and overdue/completion calculation. NO controller/HTTP logic and NO SQL.
// Stateless, deterministic (dates stamped by the repository/SQLite), never-throw, copy-on-read. UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findPending', 'findCompleted', 'findOverdue', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const TRAINING_STATUSES = ['ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'WAIVED'];
// Content fields settable via updateTraining (version/user + completedDate/assignedDate managed elsewhere).
const UPDATABLE_FIELDS = [
  'trainingProgramId', 'courseId', 'competencyId', 'dueDate', 'trainingStatus', 'mandatoryTraining',
  'assessmentRequired', 'assessmentPassed', 'score', 'attempts',
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
function withMetadata(training) {
  let metadata = null;
  try {
    metadata = training.metadataJson ? JSON.parse(training.metadataJson) : null;
  } catch (e) {
    metadata = null;
  }
  return Object.assign({}, training, { metadata });
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentTrainingService extends BaseService {
  constructor(repository, versionRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!versionRepository || typeof versionRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentTrainingService requires an injected version repository with findById()');
    }
    this.versionRepository = versionRepository;
  }

  // Assign training for a version to a user (optionally linked to a program / course / competency).
  createTraining(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (src.documentVersionId === undefined || src.documentVersionId === null) return invalid('documentVersionId is required', 'VALIDATION');
      const version = await this.versionRepository.findById(src.documentVersionId);
      if (!version) return invalid('document version not found', 'VALIDATION');
      if (!isPositiveInteger(src.userId)) return invalid('userId is required', 'VALIDATION');
      if (src.competencyId !== undefined && src.competencyId !== null && !isPositiveInteger(src.competencyId)) return invalid('invalid competencyId', 'VALIDATION');

      const trainingStatus = pick(src, 'trainingStatus', 'ASSIGNED');
      if (!TRAINING_STATUSES.includes(trainingStatus)) return invalid('invalid trainingStatus', 'VALIDATION');
      const mandatoryTraining = pick(src, 'mandatoryTraining', 0);
      if (!isBinaryFlag(mandatoryTraining)) return invalid('mandatoryTraining must be 0 or 1', 'VALIDATION');
      const assessmentRequired = pick(src, 'assessmentRequired', 0);
      if (!isBinaryFlag(assessmentRequired)) return invalid('assessmentRequired must be 0 or 1', 'VALIDATION');
      if (src.score !== undefined && !isValidScore(src.score)) return invalid('score must be an integer 0-100', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');

      const payload = {
        documentVersionId: version.id,
        userId: src.userId,
        trainingProgramId: pick(src, 'trainingProgramId', null),
        courseId: pick(src, 'courseId', null),
        competencyId: pick(src, 'competencyId', null),
        dueDate: pick(src, 'dueDate', null),
        trainingStatus,
        mandatoryTraining,
        assessmentRequired,
        assessmentPassed: 0,
        score: pick(src, 'score', null),
        attempts: 0,
        active: 1,
        archived: 0,
        deleted: 0,
        metadataJson: src.metadata !== undefined ? JSON.stringify(src.metadata) : pick(src, 'metadataJson', null),
      };
      const training = await this.repository.create(payload);
      return { ok: true, training: withMetadata(training) };
    });
  }

  updateTraining(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const current = await this.repository.findById(id);
      if (!current) return invalid('training assignment not found', 'NOT_FOUND');
      if (src.trainingStatus !== undefined && !TRAINING_STATUSES.includes(src.trainingStatus)) return invalid('invalid trainingStatus', 'VALIDATION');
      if (src.mandatoryTraining !== undefined && !isBinaryFlag(src.mandatoryTraining)) return invalid('mandatoryTraining must be 0 or 1', 'VALIDATION');
      if (src.assessmentRequired !== undefined && !isBinaryFlag(src.assessmentRequired)) return invalid('assessmentRequired must be 0 or 1', 'VALIDATION');
      if (src.competencyId !== undefined && src.competencyId !== null && !isPositiveInteger(src.competencyId)) return invalid('invalid competencyId', 'VALIDATION');
      if (src.score !== undefined && !isValidScore(src.score)) return invalid('score must be an integer 0-100', 'VALIDATION');
      if (src.metadata !== undefined && !isPlainObject(src.metadata)) return invalid('invalid metadata', 'VALIDATION');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      if (src.metadata !== undefined) payload.metadataJson = JSON.stringify(src.metadata);
      const training = await this.repository.update(id, payload);
      return { ok: true, training: withMetadata(training) };
    });
  }

  getTraining(id) {
    return execute(async () => {
      const training = await this.repository.findById(id);
      if (!training) return invalid('training assignment not found', 'NOT_FOUND');
      return { ok: true, training: withMetadata(training) };
    });
  }

  listVersionTraining(documentVersionId) {
    return execute(async () => {
      const trainings = await this.repository.findByVersion(documentVersionId);
      return { ok: true, trainings: trainings.map((t) => withMetadata(t)) };
    });
  }

  pendingTraining() {
    return execute(async () => {
      const trainings = await this.repository.findPending();
      return { ok: true, trainings: trainings.map((t) => withMetadata(t)) };
    });
  }

  completedTraining() {
    return execute(async () => {
      const trainings = await this.repository.findCompleted();
      return { ok: true, trainings: trainings.map((t) => withMetadata(t)) };
    });
  }

  overdueTraining() {
    return execute(async () => {
      const trainings = await this.repository.findOverdue();
      return { ok: true, trainings: trainings.map((t) => withMetadata(t)) };
    });
  }

  // Complete a training assignment. If an assessment is required, it must be passed; a score is
  // validated when provided. Stamps completedDate and increments attempts.
  completeTraining(id, input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      const training = await this.repository.findById(id);
      if (!training) return invalid('training assignment not found', 'NOT_FOUND');
      if (training.trainingStatus === 'COMPLETED') return invalid('training already completed', 'VALIDATION');
      if (src.score !== undefined && !isValidScore(src.score)) return invalid('score must be an integer 0-100', 'VALIDATION');
      if (training.assessmentRequired === 1 && src.assessmentPassed !== 1) return invalid('assessment must be passed to complete', 'VALIDATION');

      const payload = { trainingStatus: 'COMPLETED', completedDate: true, attempts: training.attempts + 1 };
      if (src.assessmentPassed !== undefined) payload.assessmentPassed = src.assessmentPassed;
      if (src.score !== undefined) payload.score = src.score;
      const training2 = await this.repository.update(id, payload);
      return { ok: true, training: withMetadata(training2) };
    });
  }

  // Training-completion calculation (service-level): complete when every assignment is COMPLETED.
  getTrainingCompletion(documentVersionId) {
    return execute(async () => {
      const trainings = await this.repository.findByVersion(documentVersionId);
      const total = trainings.length;
      const completed = trainings.filter((t) => t.trainingStatus === 'COMPLETED').length;
      const outstanding = total - completed;
      const mandatoryOutstanding = trainings.filter((t) => t.mandatoryTraining === 1 && t.trainingStatus !== 'COMPLETED').length;
      const complete = total > 0 && completed === total;
      return { ok: true, complete, total, completed, outstanding, mandatoryOutstanding };
    });
  }

  archiveTraining(id) {
    return execute(async () => {
      const training = await this.repository.findById(id);
      if (!training) return invalid('training assignment not found', 'NOT_FOUND');
      if (training.archived) return invalid('training assignment already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, training: withMetadata(updated) };
    });
  }

  deleteTraining(id) {
    return execute(async () => {
      const training = await this.repository.findById(id);
      if (!training) return invalid('training assignment not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreTraining(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('training assignment not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const training = await this.repository.findById(id);
      return { ok: true, training: withMetadata(training) };
    });
  }
}

module.exports = EnterpriseDocumentTrainingService;
