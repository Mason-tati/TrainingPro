const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const { status, trainTypeID, search } = req.query;
    let sql = `SELECT c.*,tt.TrainType,l.Location as LocName FROM tblCerts c
               LEFT JOIN tblTrainType tt ON c.TrainTypeID=tt.TrainTypeID
               LEFT JOIN tblLoc l ON c.LocID=l.LocID
               WHERE (c.DateRecDeleted IS NULL OR c.DateRecDeleted='')
                 AND (c.TenantID=? OR c.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (status) { sql += ' AND c.Status=?'; p.push(status); }
    if (trainTypeID) { sql += ' AND c.TrainTypeID=?'; p.push(trainTypeID); }
    if (search) { sql += ' AND (c.CertName LIKE ? OR c.CertNum LIKE ? OR c.CertType LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    sql += ' ORDER BY c.CertName';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const c = await dbGet(`SELECT c.*,tt.TrainType FROM tblCerts c LEFT JOIN tblTrainType tt ON c.TrainTypeID=tt.TrainTypeID WHERE c.CertID=? AND (c.TenantID=? OR c.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun(`INSERT INTO tblCerts
      (CertName,CertNum,CertType,Status,Months,Exam,TrHours,CurrentRev,LinkDoc,DateRecAdded,AddedBy,
       StandardBased,LastUpdateBy,GroupReq,TrainDesc,ReleaseDate,TrainTypeID,AltText,ExpPeriod,GracePer,LocID,LinkAll,DocID,ParentCertID,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,date('now'),?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
      [d.CertName,d.CertNum,d.CertType,d.Status||'Active',d.Months||null,d.Exam||0,
       d.TrHours||null,d.CurrentRev,d.LinkDoc,req.session.user.username,
       d.StandardBased||0,req.session.user.username,d.GroupReq||null,d.TrainDesc,
       d.ReleaseDate||null,d.TrainTypeID||null,d.AltText,d.ExpPeriod||'M',d.GracePer||0,
       d.LocID||null,d.DocID||null,d.ParentCertID||null,tenantOf(req)]);
    res.json({ CertID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun(`UPDATE tblCerts SET
      CertName=?,CertNum=?,CertType=?,Status=?,Months=?,Exam=?,TrHours=?,CurrentRev=?,LinkDoc=?,
      LastUpdateBy=?,StandardBased=?,GroupReq=?,TrainDesc=?,ReleaseDate=?,TrainTypeID=?,AltText=?,
      ExpPeriod=?,GracePer=?,LocID=?,DocID=?,ParentCertID=? WHERE CertID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.CertName,d.CertNum,d.CertType,d.Status,d.Months||null,d.Exam||0,
       d.TrHours||null,d.CurrentRev,d.LinkDoc,req.session.user.username,
       d.StandardBased||0,d.GroupReq||null,d.TrainDesc,d.ReleaseDate||null,
       d.TrainTypeID||null,d.AltText,d.ExpPeriod||'M',d.GracePer||0,
       d.LocID||null,d.DocID||null,d.ParentCertID||null,req.params.id,tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbRun("UPDATE tblCerts SET DateRecDeleted=date('now'),DeletedBy=? WHERE CertID=? AND (TenantID=? OR TenantID IS NULL)",
      [req.session.user.username, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/requirements', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT r.*,j.Title,d.Department,s.LastName,s.FirstName FROM tblRqd r
      LEFT JOIN tblJobs j ON r.JobID=j.JobID LEFT JOIN tblDept d ON r.DeptID=d.DeptID
      LEFT JOIN tblStaff s ON r.StaffID=s.StaffID
      WHERE r.CertID=? AND (r.DateDeleted IS NULL OR r.DateDeleted='')`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
