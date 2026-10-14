// WP-18 · E3 — ApprovalRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['DocumentID', 'WorkflowStep', 'ApprovalLevel', 'Approver', 'Decision', 'Comments'];
class ApprovalRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentApproval', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this._get('SELECT * FROM tblDocumentApproval WHERE ApprovalID = ?', [lastID]);
  }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentApproval WHERE DocumentID = ? ORDER BY ApprovalID', [documentId]); }
  async recordDecision(approvalId, decision, comments, approver) {
    await this._run("UPDATE tblDocumentApproval SET Decision = ?, Comments = ?, Approver = ?, DecisionDate = datetime('now') WHERE ApprovalID = ?", [decision, comments, approver, approvalId]);
    return this._get('SELECT * FROM tblDocumentApproval WHERE ApprovalID = ?', [approvalId]);
  }
}
module.exports = ApprovalRepository;
