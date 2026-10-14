const express = require('express');
const router = express.Router();
const { dbAll, dbGet } = require('../database/db');
const { requireAuth } = require('./auth');

router.use(requireAuth);

// Self-service: the logged-in user's own training profile
router.get('/profile', async (req, res) => {
  try {
    const sid = req.session.user.staffID;
    if (!sid) return res.json({ linked: false });
    const staff = await dbGet(`SELECT s.*,d.Department,j.Title as JobTitle,l.Location as LocName
      FROM tblStaff s LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
      LEFT JOIN tblLoc l ON s.LocID=l.LocID WHERE s.StaffID=?`, [sid]);
    res.json({ linked: true, staff });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/training', async (req, res) => {
  try {
    const sid = req.session.user.staffID;
    if (!sid) return res.json([]);
    res.json(await dbAll(`SELECT r.*,c.CertName,c.CertNum,c.Months FROM tblRegister r
      LEFT JOIN tblCerts c ON r.CertID=c.CertID
      WHERE r.StaffID=? AND (r.DateDeleted IS NULL OR r.DateDeleted='') ORDER BY r.Complete DESC`, [sid]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// My required training + current status (gap view for the employee)
router.get('/requirements', async (req, res) => {
  try {
    const sid = req.session.user.staffID;
    if (!sid) return res.json([]);
    res.json(await dbAll(`
      SELECT c.CertID,c.CertName,c.CertNum,
        MAX(CASE WHEN r.Complete IS NOT NULL AND (r.Exp IS NULL OR r.Exp='' OR r.Exp>=date('now')) THEN 1 ELSE 0 END) as IsCurrent,
        MAX(r.Complete) as LastCompleted, MAX(r.Exp) as Expiration
      FROM tblStaff s
      INNER JOIN tblRqd rq ON (rq.JobID=s.JobID OR rq.JobID IN (SELECT ej.JobID FROM tblEmpJob ej WHERE ej.EmpID=s.StaffID AND (ej.DateDeleted IS NULL OR ej.DateDeleted='')) OR rq.DeptID=s.DeptID OR rq.StaffID=s.StaffID) AND (rq.DateDeleted IS NULL OR rq.DateDeleted='')
      INNER JOIN tblCerts c ON rq.CertID=c.CertID AND (c.DateRecDeleted IS NULL OR c.DateRecDeleted='')
      LEFT JOIN tblRegister r ON r.StaffID=s.StaffID AND r.CertID=c.CertID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
      WHERE s.StaffID=? GROUP BY c.CertID ORDER BY c.CertName`, [sid]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
