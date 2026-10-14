// WP-18 · E4 — NotificationService (Enterprise Document Engine).
// Orchestrates NotificationRepository. Pure coordination — no SQL, no logging, no audit. UNWIRED.
'use strict';

const BaseService = require('./base-service');

class NotificationService extends BaseService {
  constructor(notificationRepository) {
    super(notificationRepository, ['create']);
  }

  createNotification(data) { return this.repository.create(data); }
}

module.exports = NotificationService;
