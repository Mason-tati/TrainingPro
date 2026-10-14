const express = require('express');
const router = express.Router();
const { dbAll, dbGet } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');

router.use(requireAuth);

router.get('/dashboard', async (req, res) => {
  try {
    const [totalStaff, totalCerts, totalClasses, upcomingClasses, completedThisMonth,
           expiredTraining, expiringIn30, recentCompletions, expiringRecords] = await Promise.all([
      dbGet("SELECT COUNT(*) as n FROM tblStaff WHERE Status='Active' AND (DateRecDeleted IS NULL OR DateRecDeleted='') AND (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbGet("SELECT COUNT(*) as n FROM tblCerts WHERE Status='Active' AND (DateRecDeleted IS NULL OR DateRecDeleted='') AND (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbGet("SELECT COUNT(*) as n FROM tblClass WHERE (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbGet("SELECT COUNT(*) as n FROM tblClass WHERE ClassDate >= date('now') AND (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbGet("SELECT COUNT(*) as n FROM tblRegister WHERE strftime('%Y-%m',Complete)=strftime('%Y-%m',date('now')) AND (DateDeleted IS NULL OR DateDeleted='') AND (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbGet("SELECT COUNT(*) as n FROM tblRegister WHERE Exp IS NOT NULL AND Exp!='' AND Exp < date('now') AND (DateDeleted IS NULL OR DateDeleted='') AND (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbGet("SELECT COUNT(*) as n FROM tblRegister WHERE Exp IS NOT NULL AND Exp!='' AND Exp>=date('now') AND Exp<=date('now','+30 days') AND (DateDeleted IS NULL OR DateDeleted='') AND (TenantID=? OR TenantID IS NULL)", [tenantOf(req)]),
      dbAll(`SELECT r.Complete,s.LastName,s.FirstName,c.CertName FROM tblRegister r
        LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
        WHERE r.Complete IS NOT NULL AND (r.DateDeleted IS NULL OR r.DateDeleted='')
        AND (r.TenantID=? OR r.TenantID IS NULL)
        ORDER BY r.Complete DESC LIMIT 10`, [tenantOf(req)]),
      dbAll(`SELECT r.Exp,s.LastName,s.FirstName,c.CertName FROM tblRegister r
        LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
        WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp>=date('now') AND r.Exp<=date('now','+60 days')
        AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY r.Exp LIMIT 10`, [tenantOf(req)])
    ]);
    // Overall compliance rate: of all (employee × required course) pairs, how many are current
    const compRows = await dbAll(`
      SELECT MAX(CASE WHEN r.Complete IS NOT NULL AND (r.Exp IS NULL OR r.Exp='' OR r.Exp>=date('now')) THEN 1 ELSE 0 END) as ok
      FROM tblStaff s
      INNER JOIN tblRqd rq ON (rq.JobID=s.JobID OR rq.JobID IN (SELECT ej.JobID FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')) OR rq.DeptID=s.DeptID OR rq.StaffID=s.StaffID) AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      INNER JOIN tblCerts c ON rq.CertID=c.CertID AND (c.DateRecDeleted IS NULL OR c.DateRecDeleted='')
      LEFT JOIN tblRegister r ON r.StaffID=s.StaffID AND r.CertID=c.CertID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      WHERE s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
      AND (s.TenantID=? OR s.TenantID IS NULL)
      GROUP BY s.StaffID, c.CertID`, [tenantOf(req)]);
    const totalReq = compRows.length;
    const okReq = compRows.filter(r => r.ok).length;
    const complianceRate = totalReq ? Math.round(okReq / totalReq * 100) : 100;

    res.json({
      totalStaff: totalStaff.n, totalCerts: totalCerts.n, totalClasses: totalClasses.n,
      upcomingClasses: upcomingClasses.n, completedThisMonth: completedThisMonth.n,
      expiredTraining: expiredTraining.n, expiringIn30: expiringIn30.n,
      complianceRate, totalReq, okReq,
      recentCompletions, expiringRecords
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Skills / Training Matrix (employees x required courses) ----
router.get('/matrix', async (req, res) => {
  try {
    const { deptID, locID } = req.query;
    let staffSql = `SELECT s.StaffID,s.LastName,s.FirstName,s.FileNum,s.JobID,s.DeptID,d.Department,j.Title as JobTitle
      FROM tblStaff s LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
      WHERE s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
      AND (s.TenantID=? OR s.TenantID IS NULL)`;
    const sp = [tenantOf(req)];
    if (deptID) { staffSql += ' AND s.DeptID=?'; sp.push(deptID); }
    if (locID)  { staffSql += ' AND s.LocID=?'; sp.push(locID); }
    staffSql += ' ORDER BY s.LastName,s.FirstName';
    const staff = await dbAll(staffSql, sp);

    // Map each employee to all of their job roles (multi-role aware)
    const empRoles = await dbAll(`SELECT EmpID, JobID FROM tblEmpJob WHERE (DateDeleted IS NULL OR DateDeleted='')`, []);
    const rolesByEmp = {};
    empRoles.forEach(r => { (rolesByEmp[r.EmpID] = rolesByEmp[r.EmpID] || []).push(r.JobID); });

    const rules = await dbAll(`SELECT CertID,JobID,DeptID,StaffID FROM tblRqd WHERE (DateDeleted IS NULL OR DateDeleted='')`, []);
    // Courses that are required by at least one rule
    const reqCertIds = [...new Set(rules.map(r => r.CertID).filter(Boolean))];
    let courses = [];
    if (reqCertIds.length) {
      courses = await dbAll(`SELECT CertID,CertName,CertNum,Months FROM tblCerts
        WHERE CertID IN (${reqCertIds.map(()=>'?').join(',')}) AND (DateRecDeleted IS NULL OR DateRecDeleted='') AND (TenantID=? OR TenantID IS NULL) ORDER BY CertName`, [...reqCertIds, tenantOf(req)]);
    }
    const regs = await dbAll(`SELECT StaffID,CertID,MAX(Complete) as Complete, MAX(Exp) as Exp
      FROM tblRegister WHERE (DateDeleted IS NULL OR DateDeleted='') AND (TenantID=? OR TenantID IS NULL) GROUP BY StaffID,CertID`, [tenantOf(req)]);
    const regMap = {};
    regs.forEach(r => { regMap[`${r.StaffID}_${r.CertID}`] = r; });

    const today = new Date(); today.setHours(0,0,0,0);
    const rows = staff.map(s => {
      const cells = {};
      courses.forEach(c => {
        const myRoles = rolesByEmp[s.StaffID] || [];
        const required = rules.some(r => r.CertID === c.CertID &&
          (r.StaffID === s.StaffID || (r.JobID && (r.JobID === s.JobID || myRoles.includes(r.JobID))) || (r.DeptID && r.DeptID === s.DeptID)));
        const reg = regMap[`${s.StaffID}_${c.CertID}`];
        let status = required ? 'missing' : 'na';
        let complete = reg ? reg.Complete : null, exp = reg ? reg.Exp : null;
        if (reg && reg.Complete) {
          if (!exp) status = 'current';
          else {
            const e = new Date(exp + 'T00:00:00');
            const days = Math.ceil((e - today) / 86400000);
            if (days < 0) status = 'expired';
            else if (days <= 30) status = 'expiring';
            else status = 'current';
          }
          if (!required) status = status === 'current' ? 'trained' : status;
        }
        cells[c.CertID] = { status, complete, exp, required };
      });
      return { StaffID: s.StaffID, name: `${s.LastName}, ${s.FirstName}`, FileNum: s.FileNum, Department: s.Department, JobTitle: s.JobTitle, cells };
    });
    res.json({ courses, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Notification / reminder center ----
router.get('/notifications', async (req, res) => {
  try {
    const expired = await dbAll(`SELECT r.RegisterID,r.Exp,s.StaffID,s.LastName,s.FirstName,s.Email,c.CertName
      FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
      WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp<date('now') AND s.Status='Active'
      AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY r.Exp`, [tenantOf(req)]);
    const expiring = await dbAll(`SELECT r.RegisterID,r.Exp,s.StaffID,s.LastName,s.FirstName,s.Email,c.CertName,
      CAST(julianday(r.Exp)-julianday('now') AS INT) as DaysLeft
      FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
      WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp>=date('now') AND r.Exp<=date('now','+90 days')
      AND s.Status='Active' AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY r.Exp`, [tenantOf(req)]);
    const missing = await dbAll(`SELECT s.StaffID,s.LastName,s.FirstName,s.Email,c.CertName
      FROM tblStaff s
      INNER JOIN tblRqd rq ON (rq.JobID=s.JobID OR rq.JobID IN (SELECT ej.JobID FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')) OR rq.DeptID=s.DeptID OR rq.StaffID=s.StaffID) AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      INNER JOIN tblCerts c ON rq.CertID=c.CertID
      WHERE s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
      AND (s.TenantID=? OR s.TenantID IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tblRegister r WHERE r.StaffID=s.StaffID AND r.CertID=c.CertID
        AND (r.Exp IS NULL OR r.Exp='' OR r.Exp>=date('now')) AND (r.DateDeleted IS NULL OR r.DateDeleted=''))
      ORDER BY s.LastName`, [tenantOf(req)]);
    res.json({ expired, expiring, missing, total: expired.length + expiring.length + missing.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Workforce gender breakdown (overall + by site/location)
router.get('/gender', async (req, res) => {
  try {
    const overall = await dbAll(`SELECT
        CASE WHEN Gender IS NULL OR Gender='' THEN 'Not Specified' ELSE Gender END as Gender,
        COUNT(*) as n
      FROM tblStaff WHERE Status='Active' AND (DateRecDeleted IS NULL OR DateRecDeleted='')
      AND (TenantID=? OR TenantID IS NULL)
      GROUP BY CASE WHEN Gender IS NULL OR Gender='' THEN 'Not Specified' ELSE Gender END
      ORDER BY n DESC`, [tenantOf(req)]);
    const bySite = await dbAll(`SELECT COALESCE(l.Location,'Unassigned') as Site,
        SUM(CASE WHEN s.Gender='Male' THEN 1 ELSE 0 END) as Male,
        SUM(CASE WHEN s.Gender='Female' THEN 1 ELSE 0 END) as Female,
        SUM(CASE WHEN s.Gender IS NULL OR s.Gender='' OR s.Gender NOT IN ('Male','Female') THEN 1 ELSE 0 END) as Other,
        COUNT(*) as Total
      FROM tblStaff s LEFT JOIN tblLoc l ON s.LocID=l.LocID
      WHERE s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
      AND (s.TenantID=? OR s.TenantID IS NULL)
      GROUP BY COALESCE(l.Location,'Unassigned') ORDER BY Total DESC`, [tenantOf(req)]);
    res.json({ overall, bySite });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/expiring', async (req, res) => {
  try {
    const d = parseInt(req.query.days) || 60;
    res.json(await dbAll(`SELECT r.RegisterID,r.Complete,r.Exp,r.State,
      s.StaffID,s.LastName,s.FirstName,s.FileNum,s.Email,d.Department,j.Title as JobTitle,
      c.CertID,c.CertName,c.CertNum,c.Months
      FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID
      LEFT JOIN tblCerts c ON r.CertID=c.CertID LEFT JOIN tblDept d ON s.DeptID=d.DeptID
      LEFT JOIN tblJobs j ON s.JobID=j.JobID
      WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp>=date('now') AND r.Exp<=date('now','+${d} days')
      AND s.Status='Active' AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY r.Exp`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/expired', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT r.RegisterID,r.Complete,r.Exp,r.State,
      s.StaffID,s.LastName,s.FirstName,s.FileNum,s.Email,d.Department,j.Title as JobTitle,
      c.CertID,c.CertName,c.CertNum
      FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID
      LEFT JOIN tblCerts c ON r.CertID=c.CertID LEFT JOIN tblDept d ON s.DeptID=d.DeptID
      LEFT JOIN tblJobs j ON s.JobID=j.JobID
      WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp<date('now')
      AND s.Status='Active' AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY s.LastName,c.CertName`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/missing', async (req, res) => {
  try {
    res.json(await dbAll(`
      SELECT s.StaffID,s.LastName,s.FirstName,s.FileNum,d.Department,j.Title as JobTitle,
             c.CertID,c.CertName,c.CertNum
      FROM tblStaff s LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
      INNER JOIN tblRqd rq ON (rq.JobID=s.JobID OR rq.JobID IN (SELECT ej.JobID FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')) OR rq.DeptID=s.DeptID OR rq.StaffID=s.StaffID)
                           AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      INNER JOIN tblCerts c ON rq.CertID=c.CertID
      WHERE s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
      AND (s.TenantID=? OR s.TenantID IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM tblRegister r WHERE r.StaffID=s.StaffID AND r.CertID=c.CertID
        AND (r.Exp IS NULL OR r.Exp='' OR r.Exp>=date('now')) AND (r.DateDeleted IS NULL OR r.DateDeleted=''))
      ORDER BY s.LastName,c.CertName`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/by-dept', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT d.Department,COUNT(DISTINCT s.StaffID) as EmpCount,
      COUNT(r.RegisterID) as TrainingCount,
      SUM(CASE WHEN r.Exp IS NOT NULL AND r.Exp<date('now') THEN 1 ELSE 0 END) as Expired
      FROM tblDept d
      LEFT JOIN tblStaff s ON s.DeptID=d.DeptID AND s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
      LEFT JOIN tblRegister r ON r.StaffID=s.StaffID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      GROUP BY d.DeptID ORDER BY d.Department`, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/history', async (req, res) => {
  try {
    const { staffID, certID, deptID, from, to } = req.query;
    let sql = `SELECT r.RegisterID,r.Complete,r.Exp,r.State,r.Score,r.Pass,r.Rev,
      s.LastName,s.FirstName,s.FileNum,d.Department,c.CertName,c.CertNum,cl.ClassName,cl.ClassDate
      FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID
      LEFT JOIN tblCerts c ON r.CertID=c.CertID LEFT JOIN tblDept d ON s.DeptID=d.DeptID
      LEFT JOIN tblClass cl ON r.ClassID=cl.ClassID WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
      AND (r.TenantID=? OR r.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (staffID) { sql += ' AND r.StaffID=?'; p.push(staffID); }
    if (certID)  { sql += ' AND r.CertID=?';  p.push(certID); }
    if (deptID)  { sql += ' AND s.DeptID=?';  p.push(deptID); }
    if (from)    { sql += ' AND r.Complete>=?'; p.push(from); }
    if (to)      { sql += ' AND r.Complete<=?'; p.push(to); }
    sql += ' ORDER BY r.Complete DESC,s.LastName';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
