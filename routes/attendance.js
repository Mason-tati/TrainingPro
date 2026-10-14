// Attendance — built on tblRoster (who's scheduled today) + tblLeaveBooking (who's on approved leave)
// Workflow: open the day → "Mark All Present" → tweak exceptions individually.
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

const VALID_STATUSES = new Set(['Present', 'Absent', 'Late', 'Leave', 'No Show', 'Excused']);

// ── Roster + attendance + leave merged for a date ─────────────────────────
// Returns one row per rostered employee with:
//   - their attendance row (if marked) — Status, TimeIn, TimeOut, Notes
//   - any approved leave booking covering this date (auto-populates Status='Leave')
router.get('/day', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0,10);
    // Step 1: rostered employees on duty (excludes Off)
    const rostered = await dbAll(`
      SELECT r.RosterID, r.PersonID AS EmpID, r.ShiftLabel, r.StartTime, r.EndTime,
        s.FirstName||' '||s.LastName AS EmpName, s.FirstName, s.LastName,
        d.Department AS DeptName, j.Title AS JobName
      FROM tblRoster r
      LEFT JOIN tblStaff s ON s.StaffID = r.PersonID
      LEFT JOIN tblDept d  ON d.DeptID  = s.DeptID
      LEFT JOIN tblJobs j  ON j.JobID   = s.JobID
      WHERE r.RosterDate = ? AND r.PersonType = 'employee' AND (COALESCE((SELECT MAX(st.IsOff) FROM tblShiftType st WHERE LOWER(st.Label)=LOWER(IFNULL(r.ShiftLabel,''))), CASE WHEN LOWER(IFNULL(r.ShiftLabel,''))='off' THEN 1 ELSE 0 END) = 0)
      ORDER BY EmpName`, [date]);

    // Step 2: existing attendance rows for this date (keyed by EmpID)
    const attRows = await dbAll('SELECT * FROM tblAttendance WHERE AttDate=? AND (TenantID=? OR TenantID IS NULL)', [date, tenantOf(req)]);
    const attByEmp = {};
    attRows.forEach(a => { attByEmp[a.EmpID] = a; });

    // Step 3: active approved leave bookings covering this date (keyed by EmpID)
    const leaveRows = await dbAll(`SELECT b.*, lt.Name AS LeaveTypeName, lt.Color AS LeaveTypeColor, lt.Paid
      FROM tblLeaveBooking b
      JOIN tblLeaveType lt ON lt.LeaveTypeID = b.LeaveTypeID
      WHERE b.Status='Approved' AND b.StartDate <= ? AND b.EndDate >= ?`, [date, date]);
    const leaveByEmp = {};
    leaveRows.forEach(l => { leaveByEmp[l.EmpID] = l; });

    // Step 4: include any employee on approved leave today even if NOT rostered
    // (e.g. a person on extended leave whose roster row was deleted) — so they show up correctly
    const rosteredIds = new Set(rostered.map(r => r.EmpID));
    const onlyLeave = leaveRows.filter(l => !rosteredIds.has(l.EmpID));
    for (const l of onlyLeave) {
      const s = await dbGet(`SELECT s.StaffID, s.FirstName, s.LastName, d.Department AS DeptName, j.Title AS JobName
        FROM tblStaff s LEFT JOIN tblDept d ON d.DeptID=s.DeptID LEFT JOIN tblJobs j ON j.JobID=s.JobID WHERE s.StaffID=?`, [l.EmpID]);
      if (s) rostered.push({ RosterID: null, EmpID: s.StaffID, ShiftLabel: 'Leave', StartTime: null, EndTime: null,
        EmpName: `${s.FirstName} ${s.LastName}`, FirstName: s.FirstName, LastName: s.LastName,
        DeptName: s.DeptName, JobName: s.JobName });
    }

    // Step 5: merge into the response payload
    const rows = rostered.map(r => {
      const att = attByEmp[r.EmpID] || null;
      const leave = leaveByEmp[r.EmpID] || null;
      return {
        ...r,
        attendance: att,
        leave: leave,
        effectiveStatus: att ? att.Status : (leave ? 'Leave' : 'Unmarked')
      };
    });
    rostered.sort = undefined;
    rows.sort((a, b) => (a.EmpName||'').localeCompare(b.EmpName||''));

    // Summary counts
    const summary = { total: rows.length, Present: 0, Absent: 0, Late: 0, Leave: 0, 'No Show': 0, Excused: 0, Unmarked: 0 };
    rows.forEach(r => { summary[r.effectiveStatus] = (summary[r.effectiveStatus] || 0) + 1; });

    res.json({ date, rows, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Mark all unmarked rostered employees as Present (idempotent) ───────────
// Skips anyone already marked AND anyone on approved leave (those auto-flag as 'Leave').
router.post('/mark-all-present', requireAdmin, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().slice(0,10);
    const rostered = await dbAll(`SELECT r.PersonID AS EmpID, r.ShiftLabel
      FROM tblRoster r WHERE r.RosterDate=? AND r.PersonType='employee' AND (COALESCE((SELECT MAX(st.IsOff) FROM tblShiftType st WHERE LOWER(st.Label)=LOWER(IFNULL(r.ShiftLabel,''))), CASE WHEN LOWER(IFNULL(r.ShiftLabel,''))='off' THEN 1 ELSE 0 END) = 0)`, [date]);
    const existing = await dbAll('SELECT EmpID FROM tblAttendance WHERE AttDate=? AND (TenantID=? OR TenantID IS NULL)', [date, tenantOf(req)]);
    const existingIds = new Set(existing.map(e => e.EmpID));
    const leaveIds = new Set((await dbAll(`SELECT EmpID FROM tblLeaveBooking WHERE Status='Approved' AND StartDate <= ? AND EndDate >= ?`, [date, date])).map(l => l.EmpID));
    let created = 0;
    for (const r of rostered) {
      if (existingIds.has(r.EmpID)) continue;
      if (leaveIds.has(r.EmpID)) continue; // leave is implicit; don't override
      await dbRun(`INSERT INTO tblAttendance (EmpID, AttDate, Status, ShiftLabel, MarkedBy, TenantID) VALUES (?,?,?,?,?,?)`,
        [r.EmpID, date, 'Present', r.ShiftLabel, req.session.user.username, tenantOf(req)]);
      created++;
    }
    await recordLegacyAudit(req.session.user.username, 'Attendance', 'MARK_ALL_PRESENT', null, date, null, String(created));
    res.json({ success: true, created, leaveAutoCount: leaveIds.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Mark a single employee (upsert via UNIQUE(EmpID, AttDate)) ─────────────
router.post('/mark', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.EmpID || !b.AttDate) return res.status(400).json({ error: 'EmpID & AttDate required.' });
    if (b.Status && !VALID_STATUSES.has(b.Status)) return res.status(400).json({ error: 'Invalid status.' });
    const status = b.Status || 'Present';
    // Look up shift from roster (if any) for record-keeping
    const r = await dbGet(`SELECT ShiftLabel FROM tblRoster WHERE PersonID=? AND PersonType='employee' AND RosterDate=?`, [b.EmpID, b.AttDate]);
    const shift = b.ShiftLabel || (r ? r.ShiftLabel : null);
    const existing = await dbGet('SELECT * FROM tblAttendance WHERE EmpID=? AND AttDate=? AND (TenantID=? OR TenantID IS NULL)', [b.EmpID, b.AttDate, tenantOf(req)]);
    if (existing) {
      await dbRun(`UPDATE tblAttendance SET Status=?, ShiftLabel=?, TimeIn=?, TimeOut=?, Notes=?, LeaveBookingID=?, MarkedBy=?, MarkedAt=datetime('now') WHERE AttendanceID=? AND (TenantID=? OR TenantID IS NULL)`,
        [status, shift, b.TimeIn||null, b.TimeOut||null, b.Notes||null, b.LeaveBookingID||null, req.session.user.username, existing.AttendanceID, tenantOf(req)]);
      await recordLegacyAudit(req.session.user.username, 'Attendance', 'UPDATE', existing.AttendanceID, 'Status', existing.Status, status);
      res.json({ success: true, AttendanceID: existing.AttendanceID });
    } else {
      const ins = await dbRun(`INSERT INTO tblAttendance (EmpID, AttDate, Status, ShiftLabel, TimeIn, TimeOut, Notes, LeaveBookingID, MarkedBy, TenantID) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [b.EmpID, b.AttDate, status, shift, b.TimeIn||null, b.TimeOut||null, b.Notes||null, b.LeaveBookingID||null, req.session.user.username, tenantOf(req)]);
      await recordLegacyAudit(req.session.user.username, 'Attendance', 'CREATE', ins.lastID, 'Status', null, status);
      res.json({ success: true, AttendanceID: ins.lastID });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Clear (delete) an attendance entry ─────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT * FROM tblAttendance WHERE AttendanceID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblAttendance WHERE AttendanceID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Attendance', 'DELETE', req.params.id, 'Status', existing.Status, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MONTHLY REVIEW (workforce planning) ────────────────────────────────────
// Returns a calendar matrix for a month: one row per employee who was rostered, marked,
// or on leave at any point in the month. Each row contains a `days` map keyed by day-of-month,
// plus aggregate counts so HR can spot patterns at a glance.
router.get('/month', async (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year, 10)  || now.getFullYear();
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1); // 1-12
    if (month < 1 || month > 12) return res.status(400).json({ error: 'month must be 1-12' });
    const deptId = req.query.deptId ? parseInt(req.query.deptId, 10) : null;
    const pad = n => String(n).padStart(2, '0');
    const startISO = `${year}-${pad(month)}-01`;
    const daysInMonth = new Date(year, month, 0).getDate();
    const endISO   = `${year}-${pad(month)}-${pad(daysInMonth)}`;

    // 1. Rostered employees in the month (each unique EmpID + the days they were on-duty)
    let rosterSql = `SELECT r.PersonID AS EmpID, r.RosterDate, r.ShiftLabel
      FROM tblRoster r
      LEFT JOIN tblStaff s ON s.StaffID=r.PersonID
      WHERE r.PersonType='employee' AND r.RosterDate BETWEEN ? AND ?
        AND (COALESCE((SELECT MAX(st.IsOff) FROM tblShiftType st WHERE LOWER(st.Label)=LOWER(IFNULL(r.ShiftLabel,''))), CASE WHEN LOWER(IFNULL(r.ShiftLabel,''))='off' THEN 1 ELSE 0 END) = 0)`;
    const rosterParams = [startISO, endISO];
    if (deptId) { rosterSql += ' AND s.DeptID=?'; rosterParams.push(deptId); }
    const rosterRows = await dbAll(rosterSql, rosterParams);

    // 2. Attendance records in the month
    let attSql = `SELECT a.* FROM tblAttendance a`;
    const attParams = [startISO, endISO, tenantOf(req)];
    let attWhere = ' WHERE a.AttDate BETWEEN ? AND ? AND (a.TenantID=? OR a.TenantID IS NULL)';
    if (deptId) { attSql += ' LEFT JOIN tblStaff s ON s.StaffID=a.EmpID'; attWhere += ' AND s.DeptID=?'; attParams.push(deptId); }
    const attRows = await dbAll(attSql + attWhere, attParams);

    // 3. Approved leave bookings that intersect the month
    const leaveRows = await dbAll(`SELECT b.EmpID, b.StartDate, b.EndDate, lt.Name AS LeaveTypeName, lt.Color AS LeaveTypeColor
      FROM tblLeaveBooking b
      JOIN tblLeaveType lt ON lt.LeaveTypeID = b.LeaveTypeID
      LEFT JOIN tblStaff s ON s.StaffID = b.EmpID
      WHERE b.Status='Approved' AND b.StartDate <= ? AND b.EndDate >= ?
        ${deptId ? 'AND s.DeptID=?' : ''}`, deptId ? [endISO, startISO, deptId] : [endISO, startISO]);

    // 4. Build EmpID → name/dept lookup for every employee that appears in ANY of the three sources
    const allEmpIds = new Set([
      ...rosterRows.map(r => r.EmpID),
      ...attRows.map(a => a.EmpID),
      ...leaveRows.map(l => l.EmpID)
    ]);
    if (!allEmpIds.size) {
      return res.json({ year, month, daysInMonth, rows: [], summary: { employees: 0, totalDays: 0, present: 0, absent: 0, late: 0, leave: 0, noShow: 0, excused: 0, attendanceRate: 100 } });
    }
    const idList = [...allEmpIds].join(',');
    const empMeta = await dbAll(`SELECT s.StaffID AS EmpID, s.FirstName, s.LastName, d.Department AS DeptName, j.Title AS JobName
      FROM tblStaff s LEFT JOIN tblDept d ON d.DeptID=s.DeptID LEFT JOIN tblJobs j ON j.JobID=s.JobID
      WHERE s.StaffID IN (${idList}) AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')`);

    // 5. Compose per-employee day grid + counts
    const dayOf = iso => parseInt(iso.slice(8, 10), 10);
    const empMap = {};
    empMeta.forEach(e => {
      empMap[e.EmpID] = {
        EmpID: e.EmpID,
        EmpName: `${e.FirstName||''} ${e.LastName||''}`.trim(),
        DeptName: e.DeptName || '',
        JobName: e.JobName || '',
        days: {},
        counts: { Present:0, Absent:0, Late:0, Leave:0, 'No Show':0, Excused:0, Unmarked:0, rostered:0 }
      };
    });
    // Layer 1: rostered days
    rosterRows.forEach(r => {
      const row = empMap[r.EmpID]; if (!row) return;
      const d = dayOf(r.RosterDate);
      row.days[d] = row.days[d] || { status: 'Unmarked', shift: r.ShiftLabel };
      row.counts.rostered++;
    });
    // Layer 2: leave overlays (auto-mark Leave)
    leaveRows.forEach(l => {
      const row = empMap[l.EmpID]; if (!row) return;
      const startD = Math.max(1, dayOf(l.StartDate > startISO ? l.StartDate : startISO));
      const endD   = Math.min(daysInMonth, dayOf(l.EndDate < endISO ? l.EndDate : endISO));
      for (let d = startD; d <= endD; d++) {
        row.days[d] = { status: 'Leave', leaveType: l.LeaveTypeName, leaveColor: l.LeaveTypeColor };
      }
    });
    // Layer 3: explicit attendance — wins over rostered/leave
    attRows.forEach(a => {
      const row = empMap[a.EmpID]; if (!row) return;
      const d = dayOf(a.AttDate);
      row.days[d] = { status: a.Status, shift: a.ShiftLabel, notes: a.Notes, timeIn: a.TimeIn, timeOut: a.TimeOut };
    });
    // Layer 4: tally counts from the final day-cells (overrides Unmarked tally from layer 1)
    Object.values(empMap).forEach(row => {
      row.counts = { Present:0, Absent:0, Late:0, Leave:0, 'No Show':0, Excused:0, Unmarked:0, rostered: row.counts.rostered };
      Object.values(row.days).forEach(c => { row.counts[c.status] = (row.counts[c.status] || 0) + 1; });
      const denom = row.counts.rostered || (row.counts.Present + row.counts.Absent + row.counts.Late + row.counts.Leave + row.counts['No Show'] + row.counts.Excused);
      row.attendanceRate = denom ? Math.round(((row.counts.Present + row.counts.Late + row.counts.Excused) / denom) * 100) : 100;
    });

    const rows = Object.values(empMap).sort((a, b) => a.EmpName.localeCompare(b.EmpName));

    // Aggregate summary for the whole month (workforce-planning headline)
    const summary = { employees: rows.length, totalDays: 0, Present:0, Absent:0, Late:0, Leave:0, 'No Show':0, Excused:0, Unmarked:0 };
    rows.forEach(r => {
      ['Present','Absent','Late','Leave','No Show','Excused','Unmarked'].forEach(k => summary[k] += (r.counts[k]||0));
    });
    summary.totalDays = summary.Present + summary.Absent + summary.Late + summary.Leave + summary['No Show'] + summary.Excused + summary.Unmarked;
    const denom = summary.Present + summary.Absent + summary.Late + summary.Leave + summary['No Show'] + summary.Excused;
    summary.attendanceRate = denom ? Math.round(((summary.Present + summary.Late + summary.Excused) / denom) * 100) : 100;

    res.json({ year, month, daysInMonth, rows, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── History for an employee (range) ────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const empId = req.query.empId;
    const from = req.query.from;
    const to   = req.query.to;
    if (!empId || !from || !to) return res.status(400).json({ error: 'empId, from, to required.' });
    const rows = await dbAll(`SELECT * FROM tblAttendance WHERE EmpID=? AND AttDate BETWEEN ? AND ? AND (TenantID=? OR TenantID IS NULL) ORDER BY AttDate DESC`, [empId, from, to, tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
