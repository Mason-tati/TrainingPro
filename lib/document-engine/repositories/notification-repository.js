// WP-18 · E3 — NotificationRepository (Enterprise Document Engine). Parameterized SQL. UNWIRED.
'use strict';
const BaseRepository = require('./base-repository');
const COLS = ['DocumentID', 'NotificationType', 'Recipient', 'Status'];
class NotificationRepository extends BaseRepository {
  async create(data) {
    const { sql, params } = this._buildInsert('tblDocumentNotification', data, COLS);
    const { lastID } = await this._run(sql, params);
    return this._get('SELECT * FROM tblDocumentNotification WHERE NotificationID = ?', [lastID]);
  }
  listByDocument(documentId) { return this._all('SELECT * FROM tblDocumentNotification WHERE DocumentID = ? ORDER BY NotificationID', [documentId]); }
  async updateStatus(notificationId, status) {
    await this._run('UPDATE tblDocumentNotification SET Status = ? WHERE NotificationID = ?', [status, notificationId]);
    return this._get('SELECT * FROM tblDocumentNotification WHERE NotificationID = ?', [notificationId]);
  }
}
module.exports = NotificationRepository;
