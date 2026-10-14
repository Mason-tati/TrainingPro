const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M3 — sanitizing audit (shape-preserving)
const { fireWorkflow } = require('../lib/workflow');

router.use(requireAuth);

// Digital sign-off / e-signature on a completion record.
// Re-authenticates the signer's password (21 CFR Part 11 style) before stamping.
router.post('/:id/sign', async (req, res) => {
  try {
    const { password, meaning } = req.body;
    const user = await dbGet('SELECT * FROM tblPswd WHERE PSWDID=?', [req.session.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    let valid = user.HashPass && user.HashPass !== '$2a$10$placeholder'
      ? bcrypt.compareSync(password || '', user.HashPass)
      : user.Password === password;
    if (!valid) return res.status(401).json({ error: 'Password incorrect — signature rejected.' });
    await dbRun("UPDATE tblRegister SET SignBy=?, SignDate=datetime('now'), SignMean=? WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)",
      [req.session.user.username, meaning || 'Approved', req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblRegister', 'SIGN', req.params.id, 'Signature', null, meaning || 'Approved');
    res.json({ success: true, signedBy: req.session.user.username, signedAt: new Date().toISOString() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/', async (req, res) => {
  try {
    const { staffID, certID, classID, state, expired, deptID, shiftID } = req.query;
    let sql = `SELECT r.*,s.LastName,s.FirstName,s.FileNum,c.CertName,c.CertNum,c.Months,cl.ClassName,cl.ClassDate
               FROM tblRegister r
               LEFT JOIN tblStaff s ON r.StaffID=s.StaffID
               LEFT JOIN tblCerts c ON r.CertID=c.CertID
               LEFT JOIN tblClass cl ON r.ClassID=cl.ClassID
               WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
                 AND (r.TenantID=? OR r.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (staffID) { sql += ' AND r.StaffID=?'; p.push(staffID); }
    if (certID)  { sql += ' AND r.CertID=?';  p.push(certID); }
    if (classID) { sql += ' AND r.ClassID=?'; p.push(classID); }
    if (state)   { sql += ' AND r.State=?';   p.push(state); }
    if (deptID)  { sql += ' AND s.DeptID=?';  p.push(deptID); }
    if (shiftID) { sql += ' AND s.ShiftID=?'; p.push(shiftID); }
    if (expired === '1') { sql += " AND r.Exp IS NOT NULL AND r.Exp < date('now')"; }
    sql += ' ORDER BY r.Complete DESC';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    let expDate = d.Exp || null;
    if (d.Complete && d.CertID && !expDate) {
      const cert = await dbGet('SELECT Months FROM tblCerts WHERE CertID=?', [d.CertID]);
      if (cert && cert.Months) {
        const comp = new Date(d.Complete);
        comp.setMonth(comp.getMonth() + parseInt(cert.Months));
        expDate = comp.toISOString().split('T')[0];
      }
    }
    const r = await dbRun(`INSERT INTO tblRegister
      (ClassID,StaffID,Complete,Exp,CertID,State,Paid,Score,Pass,Rev,RegLink,DueBy,LastUpdateBy,SignMean,DateStarted,DateDue,ExamID,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.ClassID||null,d.StaffID,d.Complete||null,expDate,d.CertID,
       d.State||'Completed',d.Paid||null,d.Score||null,d.Pass!=null?d.Pass:null,d.Rev,
       d.RegLink,d.DueBy||null,req.session.user.username,d.SignMean,
       d.DateStarted||null,d.DateDue||null,d.ExamID||null,tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblRegister', 'CREATE', r.lastID, 'Complete', null, d.Complete || d.State);
    // Fire workflow notifications for a completed training record
    if ((d.State || 'Completed') === 'Completed' && d.Complete) {
      try {
        const info = await dbGet(`SELECT s.FirstName,s.LastName,s.Email,s.Supervisor,c.CertName,
          sup.Email AS SupEmail FROM tblStaff s
          LEFT JOIN tblCerts c ON c.CertID=?
          LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID WHERE s.StaffID=?`, [d.CertID, d.StaffID]);
        if (info) {
          const fullName = `${info.FirstName||''} ${info.LastName||''}`.trim();
          await fireWorkflow('training_completed', {
            employeeEmail: info.Email, supervisorEmail: info.SupEmail,
            vars: { Employee: fullName, Course: info.CertName||'', Date: d.Complete, Expires: expDate||'—' }
          });
        }
      } catch (_) { /* notifications must not block the save */ }
    }
    res.json({ RegisterID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    let expDate = d.Exp || null;
    if (d.Complete && d.CertID && !expDate) {
      const cert = await dbGet('SELECT Months FROM tblCerts WHERE CertID=?', [d.CertID]);
      if (cert && cert.Months) {
        const comp = new Date(d.Complete);
        comp.setMonth(comp.getMonth() + parseInt(cert.Months));
        expDate = comp.toISOString().split('T')[0];
      }
    }
    await dbRun(`UPDATE tblRegister SET ClassID=?,StaffID=?,Complete=?,Exp=?,CertID=?,State=?,Paid=?,
      Score=?,Pass=?,Rev=?,RegLink=?,DueBy=?,LastUpdateBy=?,SignMean=?,DateStarted=?,DateDue=? WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.ClassID||null,d.StaffID,d.Complete||null,expDate,d.CertID,
       d.State,d.Paid||null,d.Score||null,d.Pass!=null?d.Pass:null,d.Rev,
       d.RegLink,d.DueBy||null,req.session.user.username,d.SignMean,
       d.DateStarted||null,d.DateDue||null,req.params.id,tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbRun("UPDATE tblRegister SET DateDeleted=date('now'),DeletedBy=? WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)",
      [req.session.user.username, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
