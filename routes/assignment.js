// Employee Assignment — bridges Attendance / Roster, Mobile Equipment, and Setup Lists.
// Each row links an employee to either a piece of equipment OR a generic duty
// (job title / location / department / free-text task) for a specific date.
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

const VALID_TYPES   = new Set(['equipment', 'duty']);
const VALID_STATUS  = new Set(['Active', 'Completed', 'Cancelled']);

// ── DAY VIEW ───────────────────────────────────────────────────────────────
// Returns one row per *rostered employee* for the date with:
//   - the employee's attendance (if marked) + active leave (if on approved leave)
//   - all assignments for the day (one employee may have multiple)
//   - a flat list of equipment units already assigned (so the picker can flag "in use")
router.get('/day', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0,10);

    // Rostered employees on duty
    const rostered = await dbAll(`
      SELECT r.PersonID AS EmpID, r.ShiftLabel, r.StartTime, r.EndTime,
        s.FirstName||' '||s.LastName AS EmpName, s.FirstName, s.LastName,
        d.Department AS DeptName, j.Title AS JobName, s.DeptID, s.JobID
      FROM tblRoster r
      LEFT JOIN tblStaff s ON s.StaffID = r.PersonID
      LEFT JOIN tblDept d  ON d.DeptID  = s.DeptID
      LEFT JOIN tblJobs j  ON j.JobID   = s.JobID
      WHERE r.RosterDate=? AND r.PersonType='employee' AND (COALESCE((SELECT MAX(st.IsOff) FROM tblShiftType st WHERE LOWER(st.Label)=LOWER(IFNULL(r.ShiftLabel,''))), CASE WHEN LOWER(IFNULL(r.ShiftLabel,''))='off' THEN 1 ELSE 0 END) = 0)
      ORDER BY EmpName`, [date]);

    // Attendance + active leave for the date (so we can show effective status)
    const attRows = await dbAll('SELECT * FROM tblAttendance WHERE AttDate=?', [date]);
    const attByEmp = {}; attRows.forEach(a => { attByEmp[a.EmpID] = a; });
    const leaveRows = await dbAll(`SELECT b.EmpID, lt.Name AS LeaveTypeName, lt.Color AS LeaveTypeColor
      FROM tblLeaveBooking b
      JOIN tblLeaveType lt ON lt.LeaveTypeID = b.LeaveTypeID
      WHERE b.Status='Approved' AND b.StartDate <= ? AND b.EndDate >= ?`, [date, date]);
    const leaveByEmp = {}; leaveRows.forEach(l => { leaveByEmp[l.EmpID] = l; });

    // All assignments for the date, joined with equipment / job / loc / dept names
    const assignments = await dbAll(`SELECT a.*, e.AssetNumber, et.Name AS EquipTypeName, et.Color AS EquipTypeColor,
        j.Title AS JobTitle, l.Location AS LocationName, d.Department AS DeptName
      FROM tblAssignment a
      LEFT JOIN tblEquipment e ON e.EquipmentID = a.EquipmentID
      LEFT JOIN tblEquipmentType et ON et.EquipTypeID = e.EquipTypeID
      LEFT JOIN tblJobs j ON j.JobID = a.JobID
      LEFT JOIN tblLoc  l ON l.LocID = a.LocID
      LEFT JOIN tblDept d ON d.DeptID = a.DeptID
      WHERE a.AssignDate=? AND (a.TenantID=? OR a.TenantID IS NULL)
      ORDER BY a.AssignedAt`, [date, tenantOf(req)]);
    const asgByEmp = {};
    assignments.forEach(a => { (asgByEmp[a.EmpID] = asgByEmp[a.EmpID] || []).push(a); });

    // Equipment in use today (for the picker to flag conflicts)
    const equipInUse = {};
    assignments.forEach(a => {
      if (a.AssignmentType === 'equipment' && a.EquipmentID && a.Status === 'Active') {
        equipInUse[a.EquipmentID] = a.EmpName;
      }
    });

    // Merge into response rows
    const rows = rostered.map(r => ({
      ...r,
      attendance: attByEmp[r.EmpID] || null,
      leave: leaveByEmp[r.EmpID] || null,
      effectiveStatus: attByEmp[r.EmpID] ? attByEmp[r.EmpID].Status : (leaveByEmp[r.EmpID] ? 'Leave' : 'Unmarked'),
      assignments: asgByEmp[r.EmpID] || []
    }));

    res.json({
      date,
      rows,
      summary: {
        total: rows.length,
        assigned: rows.filter(r => (r.assignments || []).filter(a => a.Status === 'Active').length > 0).length,
        unassigned: rows.filter(r => (r.assignments || []).filter(a => a.Status === 'Active').length === 0 && !r.leave).length,
        onLeave: rows.filter(r => !!r.leave).length
      },
      equipInUse
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── LIST (filterable) ──────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const where = ['1=1'], params = [];
    where.push('(a.TenantID=? OR a.TenantID IS NULL)'); params.push(tenantOf(req));
    if (req.query.empId) { where.push('a.EmpID=?'); params.push(req.query.empId); }
    if (req.query.equipmentId) { where.push('a.EquipmentID=?'); params.push(req.query.equipmentId); }
    if (req.query.type) { where.push('a.AssignmentType=?'); params.push(req.query.type); }
    if (req.query.from) { where.push('a.AssignDate>=?'); params.push(req.query.from); }
    if (req.query.to)   { where.push('a.AssignDate<=?'); params.push(req.query.to); }
    const sql = `SELECT a.*, s.FirstName||' '||s.LastName AS EmpName, e.AssetNumber, et.Name AS EquipTypeName,
        j.Title AS JobTitle, l.Location AS LocationName, d.Department AS DeptName
      FROM tblAssignment a
      LEFT JOIN tblStaff s ON s.StaffID=a.EmpID
      LEFT JOIN tblEquipment e ON e.EquipmentID=a.EquipmentID
      LEFT JOIN tblEquipmentType et ON et.EquipTypeID=e.EquipTypeID
      LEFT JOIN tblJobs j ON j.JobID=a.JobID
      LEFT JOIN tblLoc  l ON l.LocID=a.LocID
      LEFT JOIN tblDept d ON d.DeptID=a.DeptID
      WHERE ${where.join(' AND ')}
      ORDER BY a.AssignDate DESC, a.AssignedAt DESC LIMIT 500`;
    res.json(await dbAll(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE ─────────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.EmpID || !b.AssignDate) return res.status(400).json({ error: 'EmpID and AssignDate are required.' });
    const type = VALID_TYPES.has(b.AssignmentType) ? b.AssignmentType : 'equipment';
    if (type === 'equipment' && !b.EquipmentID) return res.status(400).json({ error: 'EquipmentID is required for an equipment assignment.' });
    if (type === 'duty' && !b.JobID && !b.LocID && !b.DeptID && !(b.TaskDescription||'').trim())
      return res.status(400).json({ error: 'A duty assignment needs at least one of JobID / LocID / DeptID / TaskDescription.' });
    const status = VALID_STATUS.has(b.Status) ? b.Status : 'Active';

    // Optional: warn if the equipment is already actively assigned that day
    if (type === 'equipment' && status === 'Active') {
      const conflict = await dbGet(`SELECT a.AssignmentID, s.FirstName||' '||s.LastName AS who
        FROM tblAssignment a LEFT JOIN tblStaff s ON s.StaffID=a.EmpID
        WHERE a.AssignDate=? AND a.EquipmentID=? AND a.Status='Active' AND (a.TenantID=? OR a.TenantID IS NULL)`, [b.AssignDate, b.EquipmentID, tenantOf(req)]);
      if (conflict && !b.allowConflict) {
        return res.status(409).json({ error: `Equipment is already assigned to ${conflict.who} today. Pass allowConflict:true to assign anyway.`, conflictWith: conflict.who });
      }
    }

    // Cache the shift label from the roster (if rostered) so historical records survive roster edits
    let shift = b.ShiftLabel || null;
    if (!shift) {
      const r = await dbGet(`SELECT ShiftLabel FROM tblRoster WHERE PersonID=? AND PersonType='employee' AND RosterDate=?`,
        [b.EmpID, b.AssignDate]);
      if (r) shift = r.ShiftLabel;
    }

    const ins = await dbRun(`INSERT INTO tblAssignment (EmpID, AssignDate, AssignmentType, EquipmentID, JobID, LocID, DeptID, ShiftLabel, TaskDescription, StartTime, EndTime, Status, Notes, AssignedBy, TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.EmpID, b.AssignDate, type, b.EquipmentID||null, b.JobID||null, b.LocID||null, b.DeptID||null,
       shift, (b.TaskDescription||null), b.StartTime||null, b.EndTime||null, status, b.Notes||null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Assignment', 'CREATE', ins.lastID, type, null, String(b.EmpID));
    res.json({ success: true, AssignmentID: ins.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE ─────────────────────────────────────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblAssignment WHERE AssignmentID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const type   = VALID_TYPES.has(b.AssignmentType) ? b.AssignmentType : existing.AssignmentType;
    const status = VALID_STATUS.has(b.Status) ? b.Status : existing.Status;
    await dbRun(`UPDATE tblAssignment SET AssignmentType=?, EquipmentID=?, JobID=?, LocID=?, DeptID=?, ShiftLabel=?, TaskDescription=?, StartTime=?, EndTime=?, Status=?, Notes=?, UpdatedAt=datetime('now') WHERE AssignmentID=? AND (TenantID=? OR TenantID IS NULL)`,
      [type, b.EquipmentID??existing.EquipmentID, b.JobID??existing.JobID, b.LocID??existing.LocID,
       b.DeptID??existing.DeptID, b.ShiftLabel??existing.ShiftLabel, b.TaskDescription??existing.TaskDescription,
       b.StartTime??existing.StartTime, b.EndTime??existing.EndTime, status, b.Notes??existing.Notes, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Assignment', 'UPDATE', req.params.id, 'Status', existing.Status, status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE ─────────────────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT EmpID, AssignDate FROM tblAssignment WHERE AssignmentID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblAssignment WHERE AssignmentID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Assignment', 'DELETE', req.params.id, null, `${existing.EmpID}@${existing.AssignDate}`, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
