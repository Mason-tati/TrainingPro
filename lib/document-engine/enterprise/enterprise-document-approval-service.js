// WP-26 · Phase 5 — Enterprise Document Engine — Approval Workflow — Service.
//
// Business orchestration over an INJECTED approval repository (reusing the certified BaseService) plus
// a READ-ONLY injected WP-26 Phase 4 document-version repository (used only to validate that the
// document version exists — never mutated). Enforces: version existence, approval-level sequencing
// (level N requires level N-1 approved), single active approval per level, approver/status
// validation, delegation, escalation, and approval-completion logic. NO controller/HTTP logic and NO
// SQL. Stateless, deterministic (dates stamped by the repository/SQLite), never-throw, copy-on-read.
// UNWIRED.
'use strict';

const BaseService = require('../services/base-service');

const REPOSITORY_METHODS = ['create', 'update', 'findById', 'findByVersion', 'findPending', 'findApproved', 'findRejected', 'archive', 'restore', 'softDelete', 'exists', 'count'];
const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DELEGATED', 'ESCALATED'];
// Content fields settable via updateApproval (level/version/decision fields are managed elsewhere).
const UPDATABLE_FIELDS = ['approverId', 'approverRole', 'approvalComments', 'dueDate'];

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
function isDecided(status) {
  return status === 'APPROVED' || status === 'REJECTED';
}
function copy(row) {
  return Object.assign({}, row);
}
async function execute(fn) {
  try {
    return await fn();
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'ERROR', code: 'ERROR' };
  }
}

class EnterpriseDocumentApprovalService extends BaseService {
  constructor(repository, versionRepository) {
    super(repository, REPOSITORY_METHODS);
    if (!versionRepository || typeof versionRepository.findById !== 'function') {
      throw new Error('EnterpriseDocumentApprovalService requires an injected version repository with findById()');
    }
    this.versionRepository = versionRepository;
  }

  // Create an approval for a version at a level. Enforces version existence, single-active-per-level,
  // and level sequencing (level N > 1 requires level N-1 approved).
  createApproval(input) {
    return execute(async () => {
      const src = isPlainObject(input) ? input : {};
      if (src.documentVersionId === undefined || src.documentVersionId === null) return invalid('documentVersionId is required', 'VALIDATION');
      const version = await this.versionRepository.findById(src.documentVersionId);
      if (!version) return invalid('document version not found', 'VALIDATION');
      const approvalLevel = pick(src, 'approvalLevel', 1);
      if (!isPositiveInteger(approvalLevel)) return invalid('approvalLevel must be a positive integer', 'VALIDATION');
      if (!isPositiveInteger(src.approverId)) return invalid('approverId is required', 'VALIDATION');
      const approvalStatus = pick(src, 'approvalStatus', 'PENDING');
      if (!APPROVAL_STATUSES.includes(approvalStatus)) return invalid('invalid approvalStatus', 'VALIDATION');

      const existing = await this.repository.findByVersion(version.id);
      if (existing.some((a) => a.approvalLevel === approvalLevel)) return invalid('an approval already exists at this level', 'CONFLICT');
      if (approvalLevel > 1) {
        const previous = existing.find((a) => a.approvalLevel === approvalLevel - 1);
        if (!previous || previous.approvalStatus !== 'APPROVED') return invalid('the previous approval level must be approved first', 'VALIDATION');
      }

      const payload = {
        documentVersionId: version.id,
        approvalLevel,
        approverId: src.approverId,
        approverRole: pick(src, 'approverRole', null),
        approvalStatus,
        approvalComments: pick(src, 'approvalComments', null),
        dueDate: pick(src, 'dueDate', null),
        delegatedTo: pick(src, 'delegatedTo', null),
        escalated: 0,
        active: 1,
        archived: 0,
        deleted: 0,
      };
      const approval = await this.repository.create(payload);
      return { ok: true, approval: copy(approval) };
    });
  }

  updateApproval(id, patch) {
    return execute(async () => {
      const src = isPlainObject(patch) ? patch : {};
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      const payload = {};
      for (const field of UPDATABLE_FIELDS) {
        if (src[field] !== undefined) payload[field] = src[field];
      }
      const updated = await this.repository.update(id, payload);
      return { ok: true, approval: copy(updated) };
    });
  }

  getApproval(id) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      return { ok: true, approval: copy(approval) };
    });
  }

  listVersionApprovals(documentVersionId) {
    return execute(async () => {
      const approvals = await this.repository.findByVersion(documentVersionId);
      return { ok: true, approvals: approvals.map(copy) };
    });
  }

  pendingApprovals() {
    return execute(async () => {
      const approvals = await this.repository.findPending();
      return { ok: true, approvals: approvals.map(copy) };
    });
  }

  approveApproval(id) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      if (isDecided(approval.approvalStatus)) return invalid('approval already decided', 'VALIDATION');
      const updated = await this.repository.update(id, { approvalStatus: 'APPROVED', approvedDate: true });
      return { ok: true, approval: copy(updated) };
    });
  }

  rejectApproval(id) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      if (isDecided(approval.approvalStatus)) return invalid('approval already decided', 'VALIDATION');
      const updated = await this.repository.update(id, { approvalStatus: 'REJECTED', rejectedDate: true });
      return { ok: true, approval: copy(updated) };
    });
  }

  // Delegate a pending/undecided approval to another approver.
  delegateApproval(id, delegatedTo) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      if (!isPositiveInteger(delegatedTo)) return invalid('delegatedTo must be a valid approver', 'VALIDATION');
      if (isDecided(approval.approvalStatus)) return invalid('approval already decided', 'VALIDATION');
      const updated = await this.repository.update(id, { approvalStatus: 'DELEGATED', delegatedTo });
      return { ok: true, approval: copy(updated) };
    });
  }

  // Escalate an undecided approval (service-level capability; stamps escalatedDate via SQL).
  escalateApproval(id) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      if (isDecided(approval.approvalStatus)) return invalid('approval already decided', 'VALIDATION');
      const updated = await this.repository.update(id, { approvalStatus: 'ESCALATED', escalated: 1, escalatedDate: true });
      return { ok: true, approval: copy(updated) };
    });
  }

  // Approval-completion logic: a version's approval is complete when every (non-deleted) approval is APPROVED.
  getApprovalCompletion(documentVersionId) {
    return execute(async () => {
      const approvals = await this.repository.findByVersion(documentVersionId);
      const total = approvals.length;
      const approved = approvals.filter((a) => a.approvalStatus === 'APPROVED').length;
      const complete = total > 0 && approved === total;
      return { ok: true, complete, total, approved };
    });
  }

  archiveApproval(id) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      if (approval.archived) return invalid('approval already archived', 'VALIDATION');
      await this.repository.archive(id);
      const updated = await this.repository.findById(id);
      return { ok: true, approval: copy(updated) };
    });
  }

  deleteApproval(id) {
    return execute(async () => {
      const approval = await this.repository.findById(id);
      if (!approval) return invalid('approval not found', 'NOT_FOUND');
      await this.repository.softDelete(id);
      return { ok: true, id };
    });
  }

  restoreApproval(id) {
    return execute(async () => {
      const present = await this.repository.exists(id);
      if (!present) return invalid('approval not found', 'NOT_FOUND');
      await this.repository.restore(id);
      const approval = await this.repository.findById(id);
      return { ok: true, approval: copy(approval) };
    });
  }
}

module.exports = EnterpriseDocumentApprovalService;
