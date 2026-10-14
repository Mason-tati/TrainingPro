// Mobile Equipment — types, units, scheduled services, breakdowns.
const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M3 — sanitizing audit (shape-preserving)

router.use(requireAuth);

const requireAdmin = (req, res, next) => {
  if (!req.session.user || !req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
  next();
};

const todayIso = () => new Date().toISOString().slice(0,10);

// ── EQUIPMENT TYPES ────────────────────────────────────────────────────────
router.get('/types', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const rows = await dbAll(`SELECT t.*, (SELECT COUNT(*) FROM tblEquipment WHERE EquipTypeID=t.EquipTypeID) AS UnitCount
      FROM tblEquipmentType t WHERE ${all ? '1=1' : 't.Active=1'} AND (t.TenantID=? OR t.TenantID IS NULL) ORDER BY t.Name`, [tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/types', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.Name || !b.Name.trim()) return res.status(400).json({ error: 'Name required.' });
    const dup = await dbGet('SELECT EquipTypeID FROM tblEquipmentType WHERE Name=? COLLATE NOCASE AND (TenantID=? OR TenantID IS NULL)', [b.Name.trim(), tenantOf(req)]);
    if (dup) return res.status(409).json({ error: 'An equipment type with that name already exists.' });
    const r = await dbRun(`INSERT INTO tblEquipmentType (Name, Category, Manufacturer, ModelNumber, ServiceIntervalHours, Color, Description, Active, TenantID) VALUES (?,?,?,?,?,?,?,?,?)`,
      [b.Name.trim(), b.Category||null, b.Manufacturer||null, b.ModelNumber||null, parseInt(b.ServiceIntervalHours,10)||250, b.Color||'#1E3A5F', b.Description||null, b.Active===0?0:1, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentType', 'CREATE', r.lastID, null, null, b.Name);
    res.json({ success: true, EquipTypeID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/types/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblEquipmentType WHERE EquipTypeID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun(`UPDATE tblEquipmentType SET Name=?, Category=?, Manufacturer=?, ModelNumber=?, ServiceIntervalHours=?, Color=?, Description=?, Active=? WHERE EquipTypeID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.Name||existing.Name, b.Category??existing.Category, b.Manufacturer??existing.Manufacturer, b.ModelNumber??existing.ModelNumber,
       parseInt(b.ServiceIntervalHours,10)||existing.ServiceIntervalHours, b.Color||existing.Color, b.Description??existing.Description,
       b.Active===0?0:1, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentType', 'UPDATE', req.params.id, 'Name', existing.Name, b.Name||existing.Name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/types/:id', requireAdmin, async (req, res) => {
  try {
    const used = await dbGet('SELECT COUNT(*) AS n FROM tblEquipment WHERE EquipTypeID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (used && used.n > 0) return res.status(409).json({ error: `Cannot delete — ${used.n} unit(s) reference this type. Set Inactive instead.` });
    const existing = await dbGet('SELECT Name FROM tblEquipmentType WHERE EquipTypeID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblEquipmentType WHERE EquipTypeID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentType', 'DELETE', req.params.id, null, existing.Name, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EQUIPMENT UNITS ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const where = [], params = [];
    where.push('(e.TenantID=? OR e.TenantID IS NULL)'); params.push(tenantOf(req));
    if (req.query.status) { where.push('e.Status=?'); params.push(req.query.status); }
    if (req.query.typeId) { where.push('e.EquipTypeID=?'); params.push(req.query.typeId); }
    if (req.query.q) {
      where.push('(e.AssetNumber LIKE ? OR e.SerialNumber LIKE ? OR e.Location LIKE ? OR t.Name LIKE ?)');
      const w = `%${req.query.q}%`; params.push(w, w, w, w);
    }
    const sql = `SELECT e.*, t.Name AS TypeName, t.Category, t.Color, t.ServiceIntervalHours,
        (SELECT COUNT(*) FROM tblEquipmentService WHERE EquipmentID=e.EquipmentID AND Status='Scheduled') AS OpenServices,
        (SELECT MIN(ScheduledDate) FROM tblEquipmentService WHERE EquipmentID=e.EquipmentID AND Status='Scheduled') AS NextServiceDate,
        (SELECT COUNT(*) FROM tblEquipmentBreakdown WHERE EquipmentID=e.EquipmentID AND Status IN ('Open','In Progress')) AS OpenBreakdowns
      FROM tblEquipment e
      LEFT JOIN tblEquipmentType t ON t.EquipTypeID=e.EquipTypeID
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY e.AssetNumber`;
    res.json(await dbAll(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const e = await dbGet(`SELECT e.*, t.Name AS TypeName, t.Category, t.Manufacturer, t.ModelNumber, t.Color, t.ServiceIntervalHours
      FROM tblEquipment e LEFT JOIN tblEquipmentType t ON t.EquipTypeID=e.EquipTypeID WHERE e.EquipmentID=? AND (e.TenantID=? OR e.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!e) return res.status(404).json({ error: 'Not found' });
    e.services = await dbAll('SELECT * FROM tblEquipmentService WHERE EquipmentID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY COALESCE(CompletedDate, ScheduledDate) DESC', [e.EquipmentID, tenantOf(req)]);
    e.breakdowns = await dbAll('SELECT * FROM tblEquipmentBreakdown WHERE EquipmentID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY BreakdownDate DESC', [e.EquipmentID, tenantOf(req)]);
    res.json(e);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.AssetNumber || !b.AssetNumber.trim()) return res.status(400).json({ error: 'AssetNumber required.' });
    const dup = await dbGet('SELECT EquipmentID FROM tblEquipment WHERE AssetNumber=? COLLATE NOCASE AND (TenantID=? OR TenantID IS NULL)', [b.AssetNumber.trim(), tenantOf(req)]);
    if (dup) return res.status(409).json({ error: 'An equipment unit with that asset number already exists.' });
    const r = await dbRun(`INSERT INTO tblEquipment (AssetNumber, EquipTypeID, SerialNumber, YearOfManufacture, PurchaseDate, Location, CurrentHours, Status, Notes, CreatedBy, TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [b.AssetNumber.trim(), b.EquipTypeID||null, b.SerialNumber||null, parseInt(b.YearOfManufacture,10)||null,
       b.PurchaseDate||null, b.Location||null, parseInt(b.CurrentHours,10)||0, b.Status||'Active', b.Notes||null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Equipment', 'CREATE', r.lastID, null, null, b.AssetNumber);
    res.json({ success: true, EquipmentID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblEquipment WHERE EquipmentID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun(`UPDATE tblEquipment SET AssetNumber=?, EquipTypeID=?, SerialNumber=?, YearOfManufacture=?, PurchaseDate=?,
      Location=?, CurrentHours=?, Status=?, Notes=?, UpdatedAt=datetime('now') WHERE EquipmentID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.AssetNumber||existing.AssetNumber, b.EquipTypeID??existing.EquipTypeID, b.SerialNumber??existing.SerialNumber,
       parseInt(b.YearOfManufacture,10)||existing.YearOfManufacture, b.PurchaseDate??existing.PurchaseDate,
       b.Location??existing.Location, parseInt(b.CurrentHours,10)||existing.CurrentHours,
       b.Status||existing.Status, b.Notes??existing.Notes, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Equipment', 'UPDATE', req.params.id, 'Status', existing.Status, b.Status||existing.Status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT AssetNumber FROM tblEquipment WHERE EquipmentID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblEquipment WHERE EquipmentID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Equipment', 'DELETE', req.params.id, null, existing.AssetNumber, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SCHEDULED SERVICES ─────────────────────────────────────────────────────
router.get('/services/all', async (req, res) => {
  try {
    const where = ['1=1'], params = [];
    where.push('(s.TenantID=? OR s.TenantID IS NULL)'); params.push(tenantOf(req));
    if (req.query.status) { where.push('s.Status=?'); params.push(req.query.status); }
    if (req.query.equipmentId) { where.push('s.EquipmentID=?'); params.push(req.query.equipmentId); }
    if (req.query.overdue === '1') { where.push("(s.Status='Scheduled' AND s.ScheduledDate < date('now'))"); }
    const sql = `SELECT s.*, e.AssetNumber, t.Name AS TypeName, t.Color
      FROM tblEquipmentService s
      LEFT JOIN tblEquipment e ON e.EquipmentID=s.EquipmentID
      LEFT JOIN tblEquipmentType t ON t.EquipTypeID=e.EquipTypeID
      WHERE ${where.join(' AND ')}
      ORDER BY COALESCE(s.ScheduledDate, s.CompletedDate) DESC LIMIT 500`;
    res.json(await dbAll(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/services', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.EquipmentID || !b.ServiceType) return res.status(400).json({ error: 'EquipmentID and ServiceType required.' });
    const status = ['Scheduled','Completed','Overdue','Cancelled'].includes(b.Status) ? b.Status : (b.CompletedDate ? 'Completed' : 'Scheduled');
    const r = await dbRun(`INSERT INTO tblEquipmentService (EquipmentID, ServiceType, ScheduledDate, CompletedDate, ScheduledHours, CompletedHours, Performer, Cost, Status, Notes, CreatedBy, TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.EquipmentID, b.ServiceType, b.ScheduledDate||null, b.CompletedDate||null, parseInt(b.ScheduledHours,10)||null,
       parseInt(b.CompletedHours,10)||null, b.Performer||null, parseFloat(b.Cost)||0, status, b.Notes||null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentService', 'CREATE', r.lastID, 'Type', null, b.ServiceType);
    res.json({ success: true, ServiceID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/services/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblEquipmentService WHERE ServiceID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const status = ['Scheduled','Completed','Overdue','Cancelled'].includes(b.Status) ? b.Status : existing.Status;
    await dbRun(`UPDATE tblEquipmentService SET ServiceType=?, ScheduledDate=?, CompletedDate=?, ScheduledHours=?, CompletedHours=?, Performer=?, Cost=?, Status=?, Notes=? WHERE ServiceID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.ServiceType||existing.ServiceType, b.ScheduledDate??existing.ScheduledDate, b.CompletedDate??existing.CompletedDate,
       parseInt(b.ScheduledHours,10)||existing.ScheduledHours, parseInt(b.CompletedHours,10)||existing.CompletedHours,
       b.Performer??existing.Performer, parseFloat(b.Cost)||existing.Cost, status, b.Notes??existing.Notes, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentService', 'UPDATE', req.params.id, 'Status', existing.Status, status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/services/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT EquipmentID FROM tblEquipmentService WHERE ServiceID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblEquipmentService WHERE ServiceID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentService', 'DELETE', req.params.id, null, String(existing.EquipmentID), null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BREAKDOWNS ─────────────────────────────────────────────────────────────
router.get('/breakdowns/all', async (req, res) => {
  try {
    const where = ['1=1'], params = [];
    where.push('(b.TenantID=? OR b.TenantID IS NULL)'); params.push(tenantOf(req));
    if (req.query.status) { where.push('b.Status=?'); params.push(req.query.status); }
    if (req.query.severity) { where.push('b.Severity=?'); params.push(req.query.severity); }
    if (req.query.equipmentId) { where.push('b.EquipmentID=?'); params.push(req.query.equipmentId); }
    const sql = `SELECT b.*, e.AssetNumber, t.Name AS TypeName, t.Color
      FROM tblEquipmentBreakdown b
      LEFT JOIN tblEquipment e ON e.EquipmentID=b.EquipmentID
      LEFT JOIN tblEquipmentType t ON t.EquipTypeID=e.EquipTypeID
      WHERE ${where.join(' AND ')}
      ORDER BY b.BreakdownDate DESC LIMIT 500`;
    res.json(await dbAll(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/breakdowns', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.EquipmentID || !b.BreakdownDate || !b.Description) return res.status(400).json({ error: 'EquipmentID, BreakdownDate and Description required.' });
    const severity = ['Critical','Major','Minor'].includes(b.Severity) ? b.Severity : 'Minor';
    const status = ['Open','In Progress','Resolved'].includes(b.Status) ? b.Status : 'Open';
    const r = await dbRun(`INSERT INTO tblEquipmentBreakdown (EquipmentID, BreakdownDate, ReportedBy, Severity, Description, RootCause, ResolvedDate, DowntimeHours, Status, Cost, Notes, TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.EquipmentID, b.BreakdownDate, b.ReportedBy||req.session.user.username, severity, b.Description.trim(),
       b.RootCause||null, b.ResolvedDate||null, parseFloat(b.DowntimeHours)||0, status, parseFloat(b.Cost)||0, b.Notes||null, tenantOf(req)]);
    // Auto-flag equipment Under Repair if breakdown is Critical/Major and still open
    if (status !== 'Resolved' && (severity === 'Critical' || severity === 'Major')) {
      await dbRun(`UPDATE tblEquipment SET Status='Under Repair', UpdatedAt=datetime('now') WHERE EquipmentID=? AND Status='Active' AND (TenantID=? OR TenantID IS NULL)`, [b.EquipmentID, tenantOf(req)]);
    }
    await recordLegacyAudit(req.session.user.username, 'EquipmentBreakdown', 'CREATE', r.lastID, 'Severity', null, severity);
    res.json({ success: true, BreakdownID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/breakdowns/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblEquipmentBreakdown WHERE BreakdownID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const severity = ['Critical','Major','Minor'].includes(b.Severity) ? b.Severity : existing.Severity;
    const status = ['Open','In Progress','Resolved'].includes(b.Status) ? b.Status : existing.Status;
    const resolved = (status === 'Resolved' && existing.Status !== 'Resolved') ? (b.ResolvedDate || todayIso()) : (b.ResolvedDate ?? existing.ResolvedDate);
    await dbRun(`UPDATE tblEquipmentBreakdown SET BreakdownDate=?, ReportedBy=?, Severity=?, Description=?, RootCause=?, ResolvedDate=?, DowntimeHours=?, Status=?, Cost=?, Notes=? WHERE BreakdownID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.BreakdownDate||existing.BreakdownDate, b.ReportedBy??existing.ReportedBy, severity, b.Description||existing.Description,
       b.RootCause??existing.RootCause, resolved, parseFloat(b.DowntimeHours)||existing.DowntimeHours,
       status, parseFloat(b.Cost)||existing.Cost, b.Notes??existing.Notes, req.params.id, tenantOf(req)]);
    // If resolved, return equipment to Active (only if it was Under Repair from this breakdown's pattern)
    if (status === 'Resolved' && existing.Status !== 'Resolved') {
      const stillOpen = await dbGet(`SELECT COUNT(*) AS n FROM tblEquipmentBreakdown WHERE EquipmentID=? AND Status IN ('Open','In Progress') AND Severity IN ('Critical','Major') AND (TenantID=? OR TenantID IS NULL)`, [existing.EquipmentID, tenantOf(req)]);
      if (stillOpen && stillOpen.n === 0) {
        await dbRun(`UPDATE tblEquipment SET Status='Active', UpdatedAt=datetime('now') WHERE EquipmentID=? AND Status='Under Repair' AND (TenantID=? OR TenantID IS NULL)`, [existing.EquipmentID, tenantOf(req)]);
      }
    }
    await recordLegacyAudit(req.session.user.username, 'EquipmentBreakdown', 'UPDATE', req.params.id, 'Status', existing.Status, status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/breakdowns/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT EquipmentID FROM tblEquipmentBreakdown WHERE BreakdownID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblEquipmentBreakdown WHERE BreakdownID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'EquipmentBreakdown', 'DELETE', req.params.id, null, String(existing.EquipmentID), null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DASHBOARD STATS ────────────────────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const counts = await dbGet(`SELECT
      (SELECT COUNT(*) FROM tblEquipment WHERE (TenantID=? OR TenantID IS NULL)) AS total,
      (SELECT COUNT(*) FROM tblEquipment WHERE Status='Active' AND (TenantID=? OR TenantID IS NULL)) AS active,
      (SELECT COUNT(*) FROM tblEquipment WHERE Status='Under Repair' AND (TenantID=? OR TenantID IS NULL)) AS repair,
      (SELECT COUNT(*) FROM tblEquipment WHERE Status='Decommissioned' AND (TenantID=? OR TenantID IS NULL)) AS decom,
      (SELECT COUNT(*) FROM tblEquipmentService WHERE Status='Scheduled' AND ScheduledDate < date('now') AND (TenantID=? OR TenantID IS NULL)) AS overdue,
      (SELECT COUNT(*) FROM tblEquipmentService WHERE Status='Scheduled' AND ScheduledDate BETWEEN date('now') AND date('now','+7 days') AND (TenantID=? OR TenantID IS NULL)) AS dueWeek,
      (SELECT COUNT(*) FROM tblEquipmentBreakdown WHERE Status IN ('Open','In Progress') AND (TenantID=? OR TenantID IS NULL)) AS openBreakdowns`,
      [tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req)]);
    res.json(counts || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
