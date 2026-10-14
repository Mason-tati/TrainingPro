const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth } = require('./auth');

router.use(requireAuth);

function adminOnly(req, res, next) {
  if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

router.get('/', adminOnly, async (req, res) => {
  try {
    res.json(await dbAll(`SELECT p.*,s.LastName,s.FirstName,d.Department,l.Location as LocName
      FROM tblPswd p LEFT JOIN tblStaff s ON p.staffID=s.StaffID
      LEFT JOIN tblDept d ON p.DeptID=d.DeptID LEFT JOIN tblLoc l ON p.LocID=l.LocID
      WHERE (p.DateDeleted IS NULL OR p.DateDeleted='') ORDER BY p.UserName`, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', adminOnly, async (req, res) => {
  try {
    const d = req.body;
    const hash = bcrypt.hashSync(d.Password, 10);
    const r = await dbRun(`INSERT INTO tblPswd
      (UserName,Password,HashPass,USER,staffID,Admin,Standard,Restricted,ExamOnly,ReadPrint,
       DeptID,LinkAll,LocID,UserStatus,PageAccess,UpdateBy,DateChanged)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,date('now'))`,
      [d.UserName,d.Password,hash,d.USER,d.staffID||null,
       d.Admin?1:0,d.Standard?1:0,d.Restricted?1:0,d.ExamOnly?1:0,d.ReadPrint?1:0,
       d.DeptID||null,d.LocID||null,d.UserStatus||'Active',d.PageAccess||null,req.session.user.username]);
    res.json({ PSWDID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', adminOnly, async (req, res) => {
  try {
    const d = req.body;
    const params = [d.UserName,d.USER,d.staffID||null,
      d.Admin?1:0,d.Standard?1:0,d.Restricted?1:0,d.ExamOnly?1:0,d.ReadPrint?1:0,
      d.DeptID||null,d.LocID||null,d.UserStatus||'Active',d.PageAccess||null,req.session.user.username];
    if (d.Password) {
      const hash = bcrypt.hashSync(d.Password, 10);
      await dbRun(`UPDATE tblPswd SET UserName=?,USER=?,staffID=?,Admin=?,Standard=?,Restricted=?,
        ExamOnly=?,ReadPrint=?,DeptID=?,LocID=?,UserStatus=?,PageAccess=?,UpdateBy=?,
        Password=?,HashPass=?,PrevPswd=Password,DateChanged=date('now') WHERE PSWDID=?`,
        [...params,d.Password,hash,req.params.id]);
    } else {
      await dbRun(`UPDATE tblPswd SET UserName=?,USER=?,staffID=?,Admin=?,Standard=?,Restricted=?,
        ExamOnly=?,ReadPrint=?,DeptID=?,LocID=?,UserStatus=?,PageAccess=?,UpdateBy=? WHERE PSWDID=?`,
        [...params,req.params.id]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    await dbRun("UPDATE tblPswd SET DateDeleted=date('now'),DeletedBy=? WHERE PSWDID=?",
      [req.session.user.username, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
