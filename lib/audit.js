const { dbRun } = require('../database/db');

// Record an entry in tblAudit. Fire-and-forget (never blocks the request).
async function logAudit(user, table, action, recordId, field, oldVal, newVal) {
  try {
    await dbRun(
      `INSERT INTO tblAudit (AuditDate,AuditUser,AuditTable,AuditAction,AuditRecord,AuditField,OldValue,NewValue)
       VALUES (datetime('now'),?,?,?,?,?,?,?)`,
      [user || 'system', table, action, recordId != null ? String(recordId) : null, field || null,
       oldVal != null ? String(oldVal) : null, newVal != null ? String(newVal) : null]
    );
  } catch (e) { /* swallow — auditing must never break the app */ }
}

module.exports = { logAudit };
