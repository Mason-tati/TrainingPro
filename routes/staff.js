const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M4 — sanitizing audit (high-risk; drops sensitive free-text)
const { fireWorkflow } = require('../lib/workflow');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { status, deptID, locID, search } = req.query;
    // Subquery surfaces any approved leave covering today — drives the "🏖️ On leave" badge in the list.
    // Returns NULL when not on leave, so frontend can simple boolean-check OnLeaveType.
    let sql = `SELECT s.*, d.Department, j.Title as JobTitle, l.Location as LocName, sh.Shift as ShiftName, et.empType,
                 (SELECT lt.Name FROM tblLeaveBooking b JOIN tblLeaveType lt ON lt.LeaveTypeID=b.LeaveTypeID
                    WHERE b.EmpID=s.StaffID AND b.Status='Approved'
                      AND b.StartDate<=date('now') AND b.EndDate>=date('now')
                    ORDER BY b.StartDate DESC LIMIT 1) AS OnLeaveType,
                 (SELECT lt.Color FROM tblLeaveBooking b JOIN tblLeaveType lt ON lt.LeaveTypeID=b.LeaveTypeID
                    WHERE b.EmpID=s.StaffID AND b.Status='Approved'
                      AND b.StartDate<=date('now') AND b.EndDate>=date('now')
                    ORDER BY b.StartDate DESC LIMIT 1) AS OnLeaveColor,
                 (SELECT b.EndDate FROM tblLeaveBooking b
                    WHERE b.EmpID=s.StaffID AND b.Status='Approved'
                      AND b.StartDate<=date('now') AND b.EndDate>=date('now')
                    ORDER BY b.StartDate DESC LIMIT 1) AS OnLeaveEnd
               FROM tblStaff s
               LEFT JOIN tblDept d ON s.DeptID=d.DeptID
               LEFT JOIN tblJobs j ON s.JobID=j.JobID
               LEFT JOIN tblLoc l ON s.LocID=l.LocID
               LEFT JOIN tblShift sh ON s.ShiftID=sh.ShiftID
               LEFT JOIN tblEmpType et ON s.empTypeID=et.empTypeID
               WHERE (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
                 AND (s.TenantID=? OR s.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (status) { sql += ' AND s.Status=?'; p.push(status); }
    if (deptID) { sql += ' AND s.DeptID=?'; p.push(deptID); }
    if (locID)  { sql += ' AND s.LocID=?';  p.push(locID); }
    if (search) { sql += ' AND (s.LastName LIKE ? OR s.FirstName LIKE ? OR s.FileNum LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    sql += ' ORDER BY s.LastName, s.FirstName';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const s = await dbGet(`SELECT s.*,d.Department,j.Title as JobTitle,l.Location as LocName,sh.Shift as ShiftName,et.empType
      FROM tblStaff s
      LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
      LEFT JOIN tblLoc l ON s.LocID=l.LocID LEFT JOIN tblShift sh ON s.ShiftID=sh.ShiftID
      LEFT JOIN tblEmpType et ON s.empTypeID=et.empTypeID WHERE s.StaffID=? AND (s.TenantID=? OR s.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun(`INSERT INTO tblStaff
      (LastName,FirstName,Status,Gender,FileNum,Supervisor,extension,JobID,StartDate,EndDate,Note,Other,
       Shift,Location,Email,empTypeID,DeptID,empLink,LocID,ShiftID,Address,DOB,SS,HomePhone,CellPhone,
       DateRecAdded,AddedBy,LastUpdateBy,LinkAll,SupID,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),?,?,0,?,?)`,
      [d.LastName,d.FirstName,d.Status||'Active',d.Gender||null,d.FileNum,d.Supervisor,d.extension,
       d.JobID||null,d.StartDate||null,d.EndDate||null,d.Note,d.Other,
       d.Shift,d.Location,d.Email,d.empTypeID||null,d.DeptID||null,d.empLink,
       d.LocID||null,d.ShiftID||null,d.Address,d.DOB||null,d.SS,d.HomePhone,d.CellPhone,
       req.session.user.username,req.session.user.username,d.SupID||null,tenantOf(req)]);
    if (d.JobID) await syncPrimaryRole(r.lastID, d.JobID, req.session.user.username);
    await recordLegacyAudit(req.session.user.username, 'tblStaff', 'CREATE', r.lastID, null, null, `${d.LastName}, ${d.FirstName}`);
    // Workflow: new employee added
    try {
      await fireWorkflow('employee_added', {
        employeeEmail: d.Email,
        vars: { Employee: `${d.FirstName||''} ${d.LastName||''}`.trim(), FileNum: d.FileNum||'', StartDate: d.StartDate||'', Date: new Date().toISOString().slice(0,10) }
      });
    } catch (_) {}
    res.json({ StaffID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun(`UPDATE tblStaff SET
      LastName=?,FirstName=?,Status=?,Gender=?,FileNum=?,Supervisor=?,extension=?,JobID=?,StartDate=?,EndDate=?,
      Note=?,Other=?,Shift=?,Location=?,Email=?,empTypeID=?,DeptID=?,empLink=?,LocID=?,ShiftID=?,
      Address=?,DOB=?,SS=?,HomePhone=?,CellPhone=?,LastUpdateBy=?,SupID=? WHERE StaffID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.LastName,d.FirstName,d.Status,d.Gender||null,d.FileNum,d.Supervisor,d.extension,
       d.JobID||null,d.StartDate||null,d.EndDate||null,d.Note,d.Other,
       d.Shift,d.Location,d.Email,d.empTypeID||null,d.DeptID||null,d.empLink,
       d.LocID||null,d.ShiftID||null,d.Address,d.DOB||null,d.SS,d.HomePhone,d.CellPhone,
       req.session.user.username,d.SupID||null,req.params.id,tenantOf(req)]);
    if (d.JobID) await syncPrimaryRole(req.params.id, d.JobID, req.session.user.username);
    await recordLegacyAudit(req.session.user.username, 'tblStaff', 'UPDATE', req.params.id, null, null, `${d.LastName}, ${d.FirstName}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbRun("UPDATE tblStaff SET DateRecDeleted=date('now'),DeletedBy=? WHERE StaffID=? AND (TenantID=? OR TenantID IS NULL)",
      [req.session.user.username, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblStaff', 'DELETE', req.params.id, null, null, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/training', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT r.*,c.CertName,c.CertNum,c.Months,c.Status as CertStatus,cl.ClassName,cl.ClassDate,cl.ClassLocation
      FROM tblRegister r LEFT JOIN tblCerts c ON r.CertID=c.CertID LEFT JOIN tblClass cl ON r.ClassID=cl.ClassID
      WHERE r.StaffID=? AND (r.DateDeleted IS NULL OR r.DateDeleted='') ORDER BY r.Complete DESC`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/notes', async (req, res) => {
  try { res.json(await dbAll('SELECT * FROM tblNotes WHERE StaffID=? ORDER BY Date DESC', [req.params.id])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/notes', async (req, res) => {
  try {
    const r = await dbRun("INSERT INTO tblNotes (StaffID,Date,Note) VALUES (?,date('now'),?)", [req.params.id, req.body.Note]);
    res.json({ NoteID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/notes/:noteId', async (req, res) => {
  try { await dbRun('DELETE FROM tblNotes WHERE NoteID=?', [req.params.noteId]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Multi-role / job titles ----
// List an employee's roles (primary first), with the # of courses each role requires.
router.get('/:id/roles', async (req, res) => {
  try {
    const roles = await dbAll(`SELECT ej.EmpJobID, ej.JobID, ej.IsPrimary, ej.DateAssigned, j.Title,
      (SELECT COUNT(*) FROM tblRqd rq WHERE rq.JobID=ej.JobID AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')) as CourseCount
      FROM tblEmpJob ej LEFT JOIN tblJobs j ON ej.JobID=j.JobID
      WHERE ej.EmpID=? AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')
      ORDER BY ej.IsPrimary DESC, j.Title`, [req.params.id]);
    res.json(roles);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign a new role to an employee
router.post('/:id/roles', async (req, res) => {
  try {
    const { JobID, makePrimary } = req.body;
    if (!JobID) return res.status(400).json({ error: 'JobID required' });
    const exists = await dbGet(`SELECT EmpJobID FROM tblEmpJob WHERE EmpID=? AND JobID=? AND (DateDeleted IS NULL OR DateDeleted='')`, [req.params.id, JobID]);
    if (exists) return res.status(400).json({ error: 'Employee already holds this role.' });
    const r = await dbRun(`INSERT INTO tblEmpJob (EmpID,JobID,IsPrimary,DateAssigned,LastUpdateBy) VALUES (?,?,?,date('now'),?)`,
      [req.params.id, JobID, makePrimary ? 1 : 0, req.session.user.username]);
    if (makePrimary) await setPrimaryRole(req.params.id, JobID, req.session.user.username);
    await dbRun(`INSERT INTO tblEmpJobHist (EmpID,JobID,Action,ChangedBy) VALUES (?,?,?,?)`,
      [req.params.id, JobID, 'Assigned', req.session.user.username]);
    await recordLegacyAudit(req.session.user.username, 'tblEmpJob', 'ROLE_ADD', req.params.id, 'JobID', null, JobID);
    res.json({ EmpJobID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Make a role the employee's primary (also updates tblStaff.JobID)
router.put('/:id/roles/:empJobId/primary', async (req, res) => {
  try {
    const row = await dbGet('SELECT JobID FROM tblEmpJob WHERE EmpJobID=?', [req.params.empJobId]);
    if (!row) return res.status(404).json({ error: 'Role not found' });
    await setPrimaryRole(req.params.id, row.JobID, req.session.user.username);
    await dbRun(`INSERT INTO tblEmpJobHist (EmpID,JobID,Action,ChangedBy) VALUES (?,?,?,?)`,
      [req.params.id, row.JobID, 'Set Primary', req.session.user.username]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Remove a role (transition out)
router.delete('/:id/roles/:empJobId', async (req, res) => {
  try {
    const row = await dbGet('SELECT JobID,IsPrimary FROM tblEmpJob WHERE EmpJobID=?', [req.params.empJobId]);
    await dbRun("UPDATE tblEmpJob SET DateDeleted=date('now'), LastUpdateBy=? WHERE EmpJobID=?", [req.session.user.username, req.params.empJobId]);
    if (row) await dbRun(`INSERT INTO tblEmpJobHist (EmpID,JobID,Action,ChangedBy) VALUES (?,?,?,?)`,
      [req.params.id, row.JobID, 'Removed', req.session.user.username]);
    await recordLegacyAudit(req.session.user.username, 'tblEmpJob', 'ROLE_REMOVE', req.params.id, 'JobID', row ? row.JobID : null, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Role-driven training profile: every course required by any of the employee's roles, with status
router.get('/:id/role-courses', async (req, res) => {
  try {
    res.json(await dbAll(`
      SELECT c.CertID, c.CertName, c.CertNum, j.Title as ViaRole, ej.JobID,
        MAX(CASE WHEN r.Complete IS NOT NULL AND (r.Exp IS NULL OR r.Exp='' OR r.Exp>=date('now')) THEN 1 ELSE 0 END) as IsCurrent,
        MAX(r.Complete) as LastCompleted, MAX(r.Exp) as Expiration
      FROM tblEmpJob ej
      JOIN tblJobs j ON ej.JobID=j.JobID
      JOIN tblRqd rq ON rq.JobID=ej.JobID AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      JOIN tblCerts c ON rq.CertID=c.CertID AND (c.DateRecDeleted IS NULL OR c.DateRecDeleted='')
      LEFT JOIN tblRegister r ON r.StaffID=ej.EmpID AND r.CertID=c.CertID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      WHERE ej.EmpID=? AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')
      GROUP BY c.CertID, ej.JobID ORDER BY j.Title, c.CertName`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Job-role transition history
router.get('/:id/role-history', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT h.*, j.Title FROM tblEmpJobHist h LEFT JOIN tblJobs j ON h.JobID=j.JobID
      WHERE h.EmpID=? ORDER BY h.HistID DESC`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ensure a primary tblEmpJob row exists matching the employee's primary JobID
// ---- Comprehensive employee report (all data in one call) ----
router.get('/:id/full-report', async (req, res) => {
  try {
    const id = req.params.id;

    // 1. Employee profile
    const emp = await dbGet(`SELECT s.*,
      d.Department, j.Title as JobTitle, l.Location as LocName,
      sh.Shift as ShiftName, et.empType,
      sup.FirstName as SupFirst, sup.LastName as SupLast, sup.Email as SupEmail,
      sup.CellPhone as SupPhone
      FROM tblStaff s
      LEFT JOIN tblDept d ON s.DeptID=d.DeptID
      LEFT JOIN tblJobs j ON s.JobID=j.JobID
      LEFT JOIN tblLoc l ON s.LocID=l.LocID
      LEFT JOIN tblShift sh ON s.ShiftID=sh.ShiftID
      LEFT JOIN tblEmpType et ON s.empTypeID=et.empTypeID
      LEFT JOIN tblStaff sup ON s.SupID=sup.StaffID
      WHERE s.StaffID=?`, [id]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // 2. Training completed (non-deleted, ordered newest first)
    const completed = await dbAll(`SELECT r.RegisterID, r.Complete, r.Exp, r.Score, r.Pass, r.State, r.Rev, r.SignBy,
      c.CertName, c.CertNum, c.CertType, c.Months, c.TrHours,
      cl.ClassName, cl.ClassDate, tr.FirstName as TrainerFirst, tr.LastName as TrainerLast
      FROM tblRegister r
      LEFT JOIN tblCerts c ON r.CertID=c.CertID
      LEFT JOIN tblClass cl ON r.ClassID=cl.ClassID
      LEFT JOIN tblTrainer tr ON cl.TrainerID=tr.TrainerID
      WHERE r.StaffID=? AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      ORDER BY r.Complete DESC`, [id]);

    // 3. Required training & compliance status
    const required = await dbAll(`SELECT c.CertID, c.CertName, c.CertNum, c.Months,
      COALESCE(j.Title,'') as ViaJob, COALESCE(d2.Department,'') as ViaDept,
      COALESCE(s2.FirstName||' '||s2.LastName,'') as ViaEmployee,
      rq.DueByDate,
      MAX(CASE WHEN r.Complete IS NOT NULL AND (r.Exp IS NULL OR r.Exp='' OR r.Exp>=date('now')) THEN 1 ELSE 0 END) as IsCurrent,
      MAX(r.Complete) as LastCompleted, MAX(r.Exp) as Expiration
      FROM tblStaff s
      INNER JOIN tblRqd rq ON (
        rq.JobID=s.JobID OR
        rq.JobID IN (SELECT ej.JobID FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')) OR
        rq.DeptID=s.DeptID OR rq.StaffID=s.StaffID
      ) AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      LEFT JOIN tblJobs j ON rq.JobID=j.JobID
      LEFT JOIN tblDept d2 ON rq.DeptID=d2.DeptID
      LEFT JOIN tblStaff s2 ON rq.StaffID=s2.StaffID
      INNER JOIN tblCerts c ON rq.CertID=c.CertID AND (c.DateRecDeleted IS NULL OR c.DateRecDeleted='')
      LEFT JOIN tblRegister r ON r.StaffID=s.StaffID AND r.CertID=c.CertID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      WHERE s.StaffID=?
      GROUP BY c.CertID ORDER BY IsCurrent ASC, c.CertName`, [id]);

    // 4. Upcoming scheduled classes
    const upcoming = await dbAll(`SELECT cl.ClassID, cl.ClassName, cl.ClassDate, cl.TimeStart, cl.TimeEnd,
      cl.ClassLocation, c.CertName, loc.ClassLoc,
      tr.FirstName as TrainerFirst, tr.LastName as TrainerLast,
      r.State as BookingState
      FROM tblRegister r
      JOIN tblClass cl ON r.ClassID=cl.ClassID
      LEFT JOIN tblCerts c ON cl.CertID=c.CertID
      LEFT JOIN tblClassLoc loc ON cl.ClassLocID=loc.ClassLocID
      LEFT JOIN tblTrainer tr ON cl.TrainerID=tr.TrainerID
      WHERE r.StaffID=? AND cl.ClassDate >= date('now')
        AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      ORDER BY cl.ClassDate`, [id]);

    // 5. Exam history with scores
    const exams = await dbAll(`SELECT e.ExamID, e.ExamDate, t.TestName, t.PassScore,
      (SELECT COUNT(*) FROM tblScore sc WHERE sc.ExamID=e.ExamID) as Total,
      (SELECT SUM(Score) FROM tblScore sc WHERE sc.ExamID=e.ExamID) as Correct
      FROM tblExam e LEFT JOIN tblTest t ON e.TestID=t.TestID
      WHERE e.EmpID=? ORDER BY e.ExamDate DESC`, [id]);
    exams.forEach(ex => { ex.ScorePct = ex.Total ? Math.round((ex.Correct||0)/ex.Total*100) : 0; ex.Passed = ex.ScorePct >= (ex.PassScore||80); });

    // 6. All job roles held
    const roles = await dbAll(`SELECT ej.EmpJobID, ej.IsPrimary, ej.DateAssigned, j.Title,
      (SELECT COUNT(*) FROM tblRqd rq WHERE rq.JobID=ej.JobID AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')) as CourseCount
      FROM tblEmpJob ej LEFT JOIN tblJobs j ON ej.JobID=j.JobID
      WHERE ej.EmpID=? AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')
      ORDER BY ej.IsPrimary DESC, j.Title`, [id]);

    // 7. Role history / career transitions
    const roleHistory = await dbAll(`SELECT h.*, j.Title FROM tblEmpJobHist h
      LEFT JOIN tblJobs j ON h.JobID=j.JobID WHERE h.EmpID=? ORDER BY h.HistID DESC LIMIT 30`, [id]);

    // 8. Documents stored
    const docCount = await dbGet(`SELECT COUNT(*) as n FROM tblFiles WHERE EntityType='staff' AND EntityID=?`, [id]);

    // 9. Expiring / expired training breakdown
    const today = new Date().toISOString().split('T')[0];
    const in90 = new Date(); in90.setDate(in90.getDate()+90);
    const summary = {
      totalRequired: required.length,
      current: required.filter(r => r.IsCurrent).length,
      expiringSoon: required.filter(r => r.Expiration && r.Expiration >= today && r.Expiration <= in90.toISOString().split('T')[0] && r.IsCurrent).length,
      expired: required.filter(r => r.Expiration && r.Expiration < today).length,
      notStarted: required.filter(r => !r.LastCompleted).length,
      complianceRate: required.length ? Math.round(required.filter(r=>r.IsCurrent).length/required.length*100) : 100
    };

    // 10. Leave bookings — recent + upcoming, joined with the leave-type catalog
    let leaveBookings = [];
    try {
      leaveBookings = await dbAll(`SELECT b.*, lt.Name AS LeaveTypeName, lt.Color AS LeaveTypeColor, lt.Paid
        FROM tblLeaveBooking b
        JOIN tblLeaveType lt ON lt.LeaveTypeID = b.LeaveTypeID
        WHERE b.EmpID = ?
        ORDER BY b.StartDate DESC LIMIT 50`, [id]);
    } catch {}

    // 11. Currently on approved leave? (used by employee-list badge too)
    let activeLeave = null;
    try {
      activeLeave = await dbGet(`SELECT b.BookingID, b.StartDate, b.EndDate, lt.Name AS LeaveTypeName, lt.Color AS LeaveTypeColor
        FROM tblLeaveBooking b
        JOIN tblLeaveType lt ON lt.LeaveTypeID = b.LeaveTypeID
        WHERE b.EmpID=? AND b.Status='Approved' AND b.StartDate <= date('now') AND b.EndDate >= date('now')
        ORDER BY b.StartDate DESC LIMIT 1`, [id]);
    } catch {}

    // 12. Attendance summary — last 30 days
    let attendance30 = { Present:0, Absent:0, Late:0, Leave:0, 'No Show':0, Excused:0, total:0, rows: [] };
    try {
      const rows = await dbAll(`SELECT AttDate, Status, ShiftLabel, TimeIn, TimeOut, Notes
        FROM tblAttendance WHERE EmpID=? AND AttDate >= date('now','-30 days') ORDER BY AttDate DESC`, [id]);
      attendance30.rows = rows;
      attendance30.total = rows.length;
      rows.forEach(r => { attendance30[r.Status] = (attendance30[r.Status] || 0) + 1; });
    } catch {}

    // 13. Onboarding record — if this staff was promoted from a candidate
    let onboarding = null;
    try {
      onboarding = await dbGet(`SELECT o.CandidateID, o.Status, o.CreatedAt,
        (SELECT COUNT(*) FROM tblOnboardingDoc WHERE CandidateID=o.CandidateID) AS docCount,
        (SELECT COUNT(*) FROM tblOnboardingReview WHERE CandidateID=o.CandidateID AND Decision='Approved') AS approvedReviews
        FROM tblOnboarding o WHERE o.PromotedStaffID=?`, [id]);
    } catch {}

    // 14. Leave balance per type (current calendar year)
    // For every active leave type, sum approved-leave days used this year and compare to DefaultDays.
    let leaveBalance = [];
    try {
      const year = new Date().getFullYear();
      const types = await dbAll('SELECT * FROM tblLeaveType WHERE Active=1 ORDER BY Name');
      for (const t of types) {
        const used = await dbGet(`SELECT COALESCE(SUM(Days),0) AS used FROM tblLeaveBooking
          WHERE EmpID=? AND LeaveTypeID=? AND Status='Approved'
            AND strftime('%Y', StartDate) = ?`, [id, t.LeaveTypeID, String(year)]);
        const pending = await dbGet(`SELECT COALESCE(SUM(Days),0) AS pending FROM tblLeaveBooking
          WHERE EmpID=? AND LeaveTypeID=? AND Status='Pending'
            AND strftime('%Y', StartDate) = ?`, [id, t.LeaveTypeID, String(year)]);
        const usedDays = Number((used && used.used) || 0);
        const pendDays = Number((pending && pending.pending) || 0);
        const entitled = t.DefaultDays || 0;
        leaveBalance.push({
          LeaveTypeID: t.LeaveTypeID, Name: t.Name, Color: t.Color, Paid: t.Paid,
          entitled, used: usedDays, pending: pendDays,
          remaining: entitled ? Math.max(0, entitled - usedDays) : null,
          overBy: entitled && usedDays > entitled ? Number((usedDays - entitled).toFixed(1)) : 0
        });
      }
    } catch {}

    // 15. Disciplinary actions for this employee
    let disciplinary = [];
    try {
      disciplinary = await dbAll(`SELECT a.*,
        (SELECT COUNT(*) FROM tblDisciplinaryDoc WHERE ActionID=a.ActionID) AS DocCount
        FROM tblDisciplinary a WHERE a.EmpID=? ORDER BY a.IssuedDate DESC, a.ActionID DESC`, [id]);
    } catch {}

    res.json({ emp, completed, required, upcoming, exams, roles, roleHistory, docCount: docCount.n, summary,
      leaveBookings, activeLeave, attendance30, onboarding, leaveBalance, disciplinary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function syncPrimaryRole(empId, jobId, user) {
  const existing = await dbGet("SELECT EmpJobID FROM tblEmpJob WHERE EmpID=? AND JobID=? AND (DateDeleted IS NULL OR DateDeleted='')", [empId, jobId]);
  await dbRun("UPDATE tblEmpJob SET IsPrimary=0 WHERE EmpID=? AND (DateDeleted IS NULL OR DateDeleted='')", [empId]);
  if (existing) {
    await dbRun('UPDATE tblEmpJob SET IsPrimary=1 WHERE EmpJobID=?', [existing.EmpJobID]);
  } else {
    await dbRun("INSERT INTO tblEmpJob (EmpID,JobID,IsPrimary,DateAssigned,LastUpdateBy) VALUES (?,?,1,date('now'),?)", [empId, jobId, user]);
    await dbRun("INSERT INTO tblEmpJobHist (EmpID,JobID,Action,ChangedBy) VALUES (?,?,'Assigned',?)", [empId, jobId, user]);
  }
}

async function setPrimaryRole(empId, jobId, user) {
  await dbRun('UPDATE tblEmpJob SET IsPrimary=0 WHERE EmpID=? AND (DateDeleted IS NULL OR DateDeleted=\'\')', [empId]);
  await dbRun('UPDATE tblEmpJob SET IsPrimary=1 WHERE EmpID=? AND JobID=? AND (DateDeleted IS NULL OR DateDeleted=\'\')', [empId, jobId]);
  await dbRun('UPDATE tblStaff SET JobID=?, LastUpdateBy=? WHERE StaffID=?', [jobId, user, empId]);
}

module.exports = router;
