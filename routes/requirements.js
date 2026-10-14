const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { certID, jobID, deptID, staffID } = req.query;
    let sql = `SELECT r.*,c.CertName,c.CertNum,j.Title,d.Department,s.LastName,s.FirstName
               FROM tblRqd r
               LEFT JOIN tblCerts c ON r.CertID=c.CertID LEFT JOIN tblJobs j ON r.JobID=j.JobID
               LEFT JOIN tblDept d ON r.DeptID=d.DeptID LEFT JOIN tblStaff s ON r.StaffID=s.StaffID
               WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
                 AND (r.TenantID=? OR r.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (certID)  { sql += ' AND r.CertID=?';  p.push(certID); }
    if (jobID)   { sql += ' AND r.JobID=?';   p.push(jobID); }
    if (deptID)  { sql += ' AND r.DeptID=?';  p.push(deptID); }
    if (staffID) { sql += ' AND r.StaffID=?'; p.push(staffID); }
    sql += ' ORDER BY c.CertName';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun(`INSERT INTO tblRqd (CertID,JobID,StaffID,DeptID,ReqTypeID,DueByDate,LastUpdateBy,TenantID) VALUES (?,?,?,?,?,?,?,?)`,
      [d.CertID||null,d.JobID||null,d.StaffID||null,d.DeptID||null,d.ReqTypeID||null,d.DueByDate||null,req.session.user.username,tenantOf(req)]);
    res.json({ RqdID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbRun("UPDATE tblRqd SET DateDeleted=date('now'),DeletedBy=? WHERE RqdID=? AND (TenantID=? OR TenantID IS NULL)",
      [req.session.user.username, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/compliance', async (req, res) => {
  try {
    res.json(await dbAll(`
      SELECT s.StaffID,s.LastName,s.FirstName,s.FileNum,d.Department,j.Title as JobTitle,
             c.CertID,c.CertName,c.CertNum,
             MAX(CASE WHEN r.Complete IS NOT NULL AND (r.Exp IS NULL OR r.Exp='' OR r.Exp >= date('now')) THEN 1 ELSE 0 END) as IsComplete,
             MAX(r.Complete) as LastCompleted, MAX(r.Exp) as Expiration
      FROM tblStaff s
      LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
      INNER JOIN tblRqd rq ON (rq.JobID=s.JobID OR rq.JobID IN (SELECT ej.JobID FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')) OR rq.DeptID=s.DeptID OR rq.StaffID=s.StaffID)
                           AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      INNER JOIN tblCerts c ON rq.CertID=c.CertID AND (c.DateRecDeleted IS NULL OR c.DateRecDeleted='')
      LEFT JOIN tblRegister r ON r.StaffID=s.StaffID AND r.CertID=c.CertID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      WHERE (s.DateRecDeleted IS NULL OR s.DateRecDeleted='') AND s.Status='Active'
        AND (s.TenantID=? OR s.TenantID IS NULL)
      GROUP BY s.StaffID,c.CertID ORDER BY s.LastName,s.FirstName,c.CertName`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
